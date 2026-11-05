// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { walk } from './helpers/walkRepo';

/*
 * The model-call fence (#339 phase 1, design R11). Every model call the app
 * makes on tenant content goes through a gate, so three facts must hold
 * statically:
 *
 *   1. Only the two gated modules, the gateway client itself and three named
 *      exceptions can reach a model endpoint: nothing else under src/,
 *      worker/ or scripts/ names the gateway's request function
 *      (postGatewayMessages) or its URL constant, or spells a model endpoint
 *      or the Anthropic version header. The exceptions are #325's gateway
 *      transports, which its own processorGate guards, the owner-run ZDR
 *      probe (a dummy prompt, never tenant content) and the owner-only
 *      discovery recorder fallback. tests/model-egress-fence.test.ts keeps
 *      every request inside the gateway client (#505).
 *   2. Inside the two gated modules and Jev's client (src/lib/ai/jev.ts),
 *      every exported function whose body can reach fetch or
 *      postGatewayMessages (directly or through module-private helpers)
 *      takes a ModelCallDecision parameter. The raw calls stay private.
 *      postGatewayMessages itself takes no decision: rule 1 is what keeps
 *      every caller of it gated.
 *   3. Production code mints a decision only as modelCallsAllowed(tenant,
 *      purpose): nothing outside the policy module names the pure evaluator,
 *      passes the minter extra arguments, or aliases it or hands it around.
 *      The minter ignores extra arguments anyway; this keeps the intent from
 *      eroding into code that looks like it can widen the gate.
 */

const ROOT = process.cwd();
const SCANNED = ['src', 'worker', 'scripts'];
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const GATED = ['src/lib/compliance/llm.ts', 'src/lib/gate0/codenameLlm.ts'];
const CLIENT = 'src/lib/modelGateway/gatewayClient.ts';
const ALLOWED = new Set([
  ...GATED,
  // The one gateway Messages client (#505): it builds the ZDR body and sends it.
  CLIENT,
  // #325: the model gateway enforces its own processorGate (assertProcessorAllowed in discovery/extract/run.ts).
  'src/lib/modelGateway/transports.ts',
  // Owner-run live ZDR probe (#462): a dummy prompt, never tenant content; CI never runs it.
  'scripts/ai/zdr-probe.ts',
  // Owner-only recorder fallback for scripts/discovery/record-extract-replies.ts; nothing under src/ imports it.
  'scripts/discovery/lib/anthropicDirect.ts',
  // D87: Jev's client, gated like the two modules above (GATED_EXPORTS); tests/jev-single-importer.test.ts keeps
  // its only app importer the second-opinion seam.
  'src/lib/ai/jev.ts',
]);
/** Modules whose exported paths to fetch must each take a ModelCallDecision. */
const GATED_EXPORTS = [...GATED, 'src/lib/ai/jev.ts'];
const ENDPOINT_LITERALS = ['api.anthropic.com', 'ai-gateway.vercel.sh', 'anthropic-version'];
/** The gateway client's request function and URL: naming either reaches the gateway. */
const GATEWAY_NAMES = ['postGatewayMessages', 'GATEWAY_MESSAGES_URL'];
/** What a function body calls to reach a model: fetch, or the gateway client. */
const REACHES_MODEL = new Set(['fetch', 'postGatewayMessages']);
const POLICY = 'src/lib/ai/modelPolicy.ts';
const MINTER = 'modelCallsAllowed';
const EVALUATOR = 'evaluateModelPolicy';

const files = SCANNED.flatMap((dir) => walk(dir)).filter((f) => SOURCE.test(f));
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');

/** What in this source reaches a model endpoint outside the gate. Plain text, so a comment counts. */
function endpointHits(source: string): string[] {
  const hits: string[] = [];
  for (const name of GATEWAY_NAMES) {
    if (new RegExp(`\\b${name}\\b`).test(source)) hits.push(`names ${name}`);
  }
  for (const literal of ENDPOINT_LITERALS) {
    if (source.includes(literal)) hits.push(`contains ${literal}`);
  }
  return hits;
}

/**
 * The exported functions of a module that can reach a model without taking a
 * ModelCallDecision parameter. A function reaches a model when its body names
 * fetch or postGatewayMessages, or a module-level function that reaches one.
 */
function ungatedExports(fileName: string, source: string): { reaching: string[]; ungated: string[] } {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  type Fn = { node: ts.FunctionLikeDeclaration; exported: boolean };
  const fns = new Map<string, Fn>();
  const isExported = (node: ts.FunctionDeclaration | ts.VariableStatement) =>
    !!node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      fns.set(stmt.name.text, { node: stmt, exported: isExported(stmt) });
    } else if (ts.isVariableStatement(stmt)) {
      const exported = isExported(stmt);
      for (const decl of stmt.declarationList.declarations) {
        const init = decl.initializer;
        if (ts.isIdentifier(decl.name) && init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
          fns.set(decl.name.text, { node: init, exported });
        }
      }
    }
  }
  // A later `export { raw }` or `export default raw` exports a private function too.
  for (const stmt of sf.statements) {
    if (ts.isExportDeclaration(stmt) && !stmt.moduleSpecifier && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      for (const el of stmt.exportClause.elements) {
        const fn = fns.get((el.propertyName ?? el.name).text);
        if (fn) fn.exported = true;
      }
    } else if (ts.isExportAssignment(stmt) && ts.isIdentifier(stmt.expression)) {
      const fn = fns.get(stmt.expression.text);
      if (fn) fn.exported = true;
    }
  }

  const callsFetch = new Map<string, boolean>();
  const edges = new Map<string, Set<string>>();
  for (const [name, fn] of fns) {
    let direct = false;
    const out = new Set<string>();
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) {
        if (REACHES_MODEL.has(node.text)) direct = true;
        else if (fns.has(node.text) && node.text !== name) out.add(node.text);
      }
      ts.forEachChild(node, visit);
    };
    if (fn.node.body) visit(fn.node.body);
    callsFetch.set(name, direct);
    edges.set(name, out);
  }

  const reaches = (start: string): boolean => {
    const seen = new Set<string>();
    const stack = [start];
    while (stack.length) {
      const name = stack.pop()!;
      if (seen.has(name)) continue;
      seen.add(name);
      if (callsFetch.get(name)) return true;
      stack.push(...(edges.get(name) ?? []));
    }
    return false;
  };

  const takesDecision = (fn: ts.FunctionLikeDeclaration) =>
    fn.parameters.some((p) => !!p.type && /\bModelCallDecision\b/.test(p.type.getText(sf)));

  const reaching = [...fns].filter(([name, fn]) => fn.exported && reaches(name)).map(([name]) => name);
  const ungated = reaching.filter((name) => !takesDecision(fns.get(name)!.node));
  return { reaching, ungated };
}

/**
 * How a module reaches the gate other than by calling the minter with
 * exactly a tenant and a purpose: naming the evaluator, calling the minter
 * with another arity or a spread, aliasing it on import, or referencing it
 * anywhere but as a direct callee.
 */
function gateMisuse(fileName: string, source: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hits: string[] = [];
  const at = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === EVALUATOR) hits.push(`line ${at(node)}: names ${EVALUATOR}`);
    if (ts.isIdentifier(node) && node.text === MINTER) {
      const parent = node.parent;
      const target = ts.isPropertyAccessExpression(parent) && parent.name === node ? parent : node;
      const call = target.parent;
      if (ts.isImportSpecifier(parent)) {
        if (parent.propertyName) hits.push(`line ${at(node)}: aliases ${MINTER}`);
      } else if (!ts.isCallExpression(call) || call.expression !== target) {
        hits.push(`line ${at(node)}: references ${MINTER} outside a direct call`);
      } else if (call.arguments.length !== 2 || call.arguments.some(ts.isSpreadElement)) {
        hits.push(`line ${at(node)}: calls ${MINTER} with ${call.arguments.length} arguments`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

describe('only the gated modules reach a model endpoint (#339)', () => {
  it('scans src/, worker/ and scripts/', () => {
    for (const dir of SCANNED) expect(files.some((f) => f.startsWith(`${dir}/`)), dir).toBe(true);
  });

  it('finds the endpoint in the allowed modules (the scan is not vacuous)', () => {
    expect(endpointHits(read(CLIENT))).toEqual(
      expect.arrayContaining(['names postGatewayMessages', 'contains ai-gateway.vercel.sh', 'contains anthropic-version']),
    );
    for (const file of GATED) {
      expect(endpointHits(read(file)), file).toContain('names postGatewayMessages');
    }
  });

  it('no other module names the gateway client or a model endpoint', () => {
    const offenders = files
      .filter((f) => !ALLOWED.has(f))
      .flatMap((f) => endpointHits(read(f)).map((h) => `${f}: ${h}`));
    expect(offenders).toEqual([]);
  });

  it('every allowed module still reaches an endpoint (no stale exception)', () => {
    const stale = [...ALLOWED].filter((f) => endpointHits(read(f)).length === 0);
    expect(stale).toEqual([]);
  });

  it('the detector catches the gateway names, whole words only, and each literal', () => {
    expect(endpointHits("import { postGatewayMessages } from '@/lib/modelGateway/gatewayClient';")).toEqual([
      'names postGatewayMessages',
    ]);
    expect(endpointHits("const m = await import('../modelGateway/transports'); m.postGatewayMessages(req);")).toHaveLength(1);
    expect(endpointHits('fetch(GATEWAY_MESSAGES_URL)')).toEqual(['names GATEWAY_MESSAGES_URL']);
    expect(endpointHits("fetch('https://ai-gateway.vercel.sh/v1')")).toEqual(['contains ai-gateway.vercel.sh']);
    expect(endpointHits("fetch('https://api.anthropic.com/v1/messages')")).toEqual(['contains api.anthropic.com']);
    expect(endpointHits("import { warnOnce, gatewayKeyConfigured } from '@/lib/modelGateway/gatewayClient';")).toEqual([]);
    expect(endpointHits('const postGatewayMessagesCount = 0;')).toEqual([]);
  });
});

describe('every exported path to a model in the gated modules takes a decision (#339)', () => {
  it.each(GATED_EXPORTS)('%s', (file) => {
    const { reaching, ungated } = ungatedExports(file, read(file));
    expect(reaching.length, 'the module has a gated entry point that reaches a model').toBeGreaterThan(0);
    expect(ungated).toEqual([]);
  });

  it('the detector flags an exported raw call, an exported wrapper of a private one, and a gateway call', () => {
    const source = [
      "import type { ModelCallDecision } from '@/lib/ai/modelPolicy';",
      'async function raw() { return fetch("x"); }',
      'export async function leak(text: string) { return fetch(text); }',
      'export const wrapper = async (text: string) => raw();',
      'export async function gated(text: string, model: ModelCallDecision) { return raw(); }',
      'async function viaGateway() { return postGatewayMessages({}); }',
      'export async function gatewayLeak(text: string) { return viaGateway(); }',
      'export async function gatewayGated(text: string, model: ModelCallDecision) { return viaGateway(); }',
      'export function pure(text: string) { return text.length; }',
      'async function late() { return raw(); }',
      'export { late };',
    ].join('\n');
    const { reaching, ungated } = ungatedExports('probe.ts', source);
    expect(reaching.sort()).toEqual(['gated', 'gatewayGated', 'gatewayLeak', 'late', 'leak', 'wrapper']);
    expect(ungated.sort()).toEqual(['gatewayLeak', 'late', 'leak', 'wrapper']);
  });
});

describe('production code mints a decision only as modelCallsAllowed(tenant, purpose) (#339)', () => {
  it('finds the minter in the route that sends mail (the scan is not vacuous)', () => {
    expect(read('src/app/api/v1/outbox/route.ts')).toContain(`${MINTER}(`);
    expect(gateMisuse('route.ts', read('src/app/api/v1/outbox/route.ts'))).toEqual([]);
  });

  it('no module outside the policy names the evaluator or misuses the minter', () => {
    const offenders = files
      .filter((f) => f !== POLICY)
      .flatMap((f) => gateMisuse(f, read(f)).map((h) => `${f}: ${h}`));
    expect(offenders).toEqual([]);
  });

  it('the detector flags the evaluator, extra arguments, a spread, an alias and a handed-around minter', () => {
    const source = [
      "import { evaluateModelPolicy, modelCallsAllowed } from '@/lib/ai/modelPolicy';",
      "import { modelCallsAllowed as mint } from '@/lib/ai/modelPolicy';",
      "const ok = modelCallsAllowed(tenant, 'mail_screen');",
      "const okToo = policy.modelCallsAllowed(tenant, 'mail_screen');",
      "const wide = modelCallsAllowed(tenant, 'mail_screen', env, { verifiedProcessors: ['anthropic'] });",
      'const spread = modelCallsAllowed(...args);',
      "const viaCall = modelCallsAllowed.call(null, tenant, 'mail_screen', env);",
      'const handed = [modelCallsAllowed];',
      'const verdict = evaluateModelPolicy(tenant, env, policy);',
    ].join('\n');
    expect(gateMisuse('probe.ts', source)).toEqual([
      'line 1: names evaluateModelPolicy',
      'line 2: aliases modelCallsAllowed',
      'line 5: calls modelCallsAllowed with 4 arguments',
      'line 6: calls modelCallsAllowed with 1 arguments',
      'line 7: references modelCallsAllowed outside a direct call',
      'line 8: references modelCallsAllowed outside a direct call',
      'line 9: names evaluateModelPolicy',
    ]);
  });
});
