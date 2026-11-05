// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';

// Source scope on the worker's three routing paths (#173 G-09 3/6): the context bootstrap (loadRoutingContext), the
// per-page route (syncSource) and tenant discovery (discoverTenant). `scope` is a required option of the router, so the
// type checker refuses a call that leaves it out; these pins hold what the types cannot: that nothing in worker/ opts
// out with 'unscoped', that each path takes its scope from the tenant's own sources, and that the production context
// is built only by the bootstrap. A source-text pin in the style of reader-pass-pins.test.ts: comment lines are
// stripped first, and function bodies and call arguments are sliced by brace and paren counting, so an "inside"
// assertion cannot pass vacuously.

// Comment lines (// …, /** …, * …) are not code: strip them before matching.
const code = (file: string) =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join('\n');

/** The body of the function whose declaration starts at `signature`, from its opening brace to the matching one. */
function bodyOf(text: string, signature: string, bodyStartsAfter: string): string {
  const at = text.indexOf(signature);
  expect(at, `${signature} not found`).toBeGreaterThanOrEqual(0);
  const after = text.indexOf(bodyStartsAfter, at);
  expect(after, `${bodyStartsAfter} not found after ${signature}`).toBeGreaterThanOrEqual(0);
  const open = text.indexOf('{', after + bodyStartsAfter.length - 1);
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}' && (depth -= 1) === 0) return text.slice(open, i + 1);
  }
  throw new Error(`unbalanced braces after ${signature}`);
}

/** The argument text of every call to `name(` in `text` (not its declaration), from the paren to the matching one. */
function callsOf(text: string, name: string): string[] {
  const calls: string[] = [];
  for (const match of text.matchAll(new RegExp(`(?<!function )\\b${name}\\(`, 'g'))) {
    const open = match.index! + name.length;
    let depth = 0;
    for (let i = open; i < text.length; i += 1) {
      if (text[i] === '(') depth += 1;
      else if (text[i] === ')' && (depth -= 1) === 0) {
        calls.push(text.slice(open, i + 1));
        break;
      }
    }
  }
  return calls;
}

const workerFiles = readdirSync('worker', { recursive: true, encoding: 'utf8' })
  .filter((f) => /\.(ts|mjs)$/.test(f))
  .map((f) => path.join('worker', f));
const workerCode = new Map(workerFiles.map((f) => [f, code(f)]));
const everywhere = (name: string) =>
  [...workerCode].flatMap(([file, text]) => callsOf(text, name).map((args) => ({ file, args })));

const sync = code('worker/sync.ts');

it('worker/ calls the router in three places, and each takes its scope from the tenant, not from a literal', () => {
  const calls = everywhere('routeByFirmRules');
  // contextFromStored, syncSource's page, and routeStored (discoverTenant's route): a fourth call is a new path to pin.
  expect(calls.map((c) => c.file)).toEqual(['worker/sync.ts', 'worker/sync.ts', 'worker/sync.ts']);
  const [bootstrap, page, discovery] = calls.map((c) => c.args);
  expect(bootstrap).toMatch(/\bscope\b/); // contextFromStored(…, scope)
  expect(page).toMatch(/\.\.\.context\.options\(\)/); // the context carries the scope (pinned below)
  expect(page).toMatch(/counts:\s*blocked\b/);
  expect(discovery).toMatch(/\.\.\.options\b/); // routeStored: its options type requires scope
  for (const { args } of calls) expect(args).not.toMatch(/['"]unscoped['"]/);
});

it("nothing in worker/ opts out of the scope: 'unscoped' is only the default of a bare RoutingContext", () => {
  const hits = [...workerCode].flatMap(([file, text]) => (text.match(/['"]unscoped['"]/g) ?? []).map(() => file));
  expect(hits).toEqual(['worker/sync.ts']);
  const context = bodyOf(sync, 'export class RoutingContext {', 'RoutingContext {');
  expect(context.match(/['"]unscoped['"]/g)).toHaveLength(1);
  expect(context).toMatch(/scope: RoutingScope = 'unscoped';/);
});

it('RoutingContext.options() hands the router its scope and what each key was taught in', () => {
  const context = bodyOf(sync, 'export class RoutingContext {', 'RoutingContext {');
  const options = bodyOf(context, '  options()', 'options() {');
  expect(options).toMatch(/knownCodenames: \[\.\.\.this\.codenames\]\.map\(\(\[key, \{ codename, taughtIn \}\]\) => \(\{ key, codename, taughtIn \}\)\)/);
  expect(options).toMatch(/knownThreads: this\.threads/);
  expect(options).toMatch(/scope: this\.scope/);
});

it('the bootstrap builds its context from the stored items under the tenant\'s shared sources', () => {
  const load = bodyOf(sync, 'export async function loadRoutingContext(', 'Promise<RoutingContext> {');
  // Archived sources keep their observations and stay shared (they still refuse) but teach and promote nothing.
  expect(load).toMatch(/routingInputs\(sources\)/);
  expect(load).toMatch(/const \{ items \} = await loadStoredItems\(db, tenantId\);/);
  expect(load).toMatch(/const sources = await firmSources\(db, tenantId\);/);
  expect(load).not.toMatch(/firmRouting\(/);
  const calls = callsOf(load, 'contextFromStored');
  expect(calls).toHaveLength(1);
  // The stored items also seed the subject prefix evidence, with every mailbox's owner (#173 G-09 3b).
  expect(calls[0]).toMatch(/\{ shared \}, \{ internalDomains, sourceOwners, archived \}\)$/);
  expect(load).not.toMatch(/\bnew RoutingContext\(/);
  expect(load).not.toMatch(/\brouteByFirmRules\(/);
});

it('the production context is built in one place, contextFromStored, and nothing else in worker/ makes one', () => {
  const constructors = [...workerCode].flatMap(([file, text]) => (text.match(/\bnew RoutingContext\(/g) ?? []).map(() => file));
  expect(constructors).toEqual(['worker/sync.ts']);
  const helper = bodyOf(sync, 'export function contextFromStored(', '): RoutingContext {');
  expect(helper).toMatch(/\bnew RoutingContext\(\)/);
  expect(helper).toMatch(/context\.scope = scope;/);
  expect(callsOf(helper, 'routeByFirmRules')[0]).toMatch(/\{ knownCodenames: known, scope, archived: context\.archived \}/);
  // classify.ts reaches the context only through loadRoutingContext, from both entry points.
  const classify = workerCode.get('worker/classify.ts')!;
  expect(classify.match(/\bloadRoutingContext\(/g)).toHaveLength(2);
});

it('the per-page route holds each page to the context\'s scope and counts what it refuses', () => {
  const body = bodyOf(sync, 'export async function syncSource(', 'Promise<SyncResult> {');
  expect(callsOf(body, 'routeByFirmRules')).toHaveLength(1);
  expect(body).toMatch(/const blocked: RouteCounts = \{ scopeBlocked: 0 \};/);
  expect(body).toMatch(/result\.routing\.scopeBlocked \+= blocked\.scopeBlocked;/);
  // The page is routed before it is stored, and what it learns is learned from what was stored.
  expect(body.indexOf('routeByFirmRules(')).toBeLessThan(body.indexOf('persistItems('));
  expect(body).toMatch(/context\.learn\(routed\.filter\(/);
});

it('tenant discovery routes through routeStored under the tenant\'s shared sources', () => {
  const body = bodyOf(sync, 'export async function discoverTenant(', 'Promise<CandidateResult[]> {');
  expect(body).toMatch(/routingInputs\(await firmSources\(db, options\.tenantId\)\)/);
  expect(body).toMatch(/const \{ items, itemIds \} = await loadStoredItems\(db, options\.tenantId\);/);
  expect(body).not.toMatch(/firmRouting\(/);
  const calls = callsOf(body, 'routeStored');
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatch(/scope: \{ shared \},\s+archived,/);
  expect(calls[0]).toMatch(/knownCodenames: await candidateCodenames\(db, options\.tenantId\)/);
  expect(body).not.toMatch(/\brouteByFirmRules\(/);
});

it('routeStored is discovery\'s only caller of the helper, and every contextFromStored call passes a scope', () => {
  expect(everywhere('routeStored').map((c) => c.file)).toEqual(['worker/sync.ts']);
  for (const { args } of everywhere('contextFromStored')) expect(args).toMatch(/\bscope\b|\{ shared \}/);
  const helper = bodyOf(sync, 'export function routeStored(', '{ routed: RoutedItem[]; counts: RouteCounts } {');
  expect(callsOf(helper, 'routeByFirmRules')[0]).toMatch(/\{ \.\.\.options, counts \}/);
});

it('the shared sources are the team inboxes and the mailboxes with no owner, read whole', () => {
  const routing = bodyOf(sync, 'export function firmRouting(', 'shared: Set<string>;\n} {');
  expect(routing).toMatch(/\.filter\(\(s\) => s\.team_mailbox_id \|\| \(!s\.owner_user_id && s\.kind !== SOURCE_KIND\.SHAREPOINT_SITE\)\)/);
  const read = bodyOf(sync, 'async function firmSources(', 'Promise<FirmSource[]> {');
  expect(read).toMatch(/\.select\('id, address, kind, team_mailbox_id, owner_user_id, archived_at', \{ count: 'exact' \}\)/);
  expect(read).toMatch(/\.order\('id'\)/);
  expect(read).toMatch(/if \(all\.length !== expected\) throw/);
});

it('prefix evidence is carried page to page from every item the router saw, and handed back to the router (3b)', () => {
  const context = bodyOf(sync, 'export class RoutingContext {', 'RoutingContext {');
  const options = bodyOf(context, '  options()', 'options() {');
  expect(options).toMatch(/knownPrefixEvidence: this\.prefixEvidence/);
  const body = bodyOf(sync, 'export async function syncSource(', 'Promise<SyncResult> {');
  const route = callsOf(body, 'routeByFirmRules')[0];
  expect(route).toMatch(/sourceOwners: owner/);
  // After the store (audit P2): every item the router saw that was stored or routed nowhere, never a refused collision.
  const notes = callsOf(body, 'context.notePrefixes');
  expect(notes).toHaveLength(1);
  expect(notes[0]).toMatch(/routed\.filter\(\(entry\) => entry\.routes\.length === 0 \|\| storedKeys\.has\(entry\.item\.internetMessageId\)\)/);
  expect(body.indexOf('persistItems(')).toBeLessThan(body.indexOf('context.notePrefixes('));
  expect(body.indexOf('const storedKeys = new Set(stored.storedKeys);')).toBeLessThan(body.indexOf('context.notePrefixes('));
});

it('the prefix ledger never leaves RoutingContext: no write, log or count reads it (3b)', () => {
  const context = bodyOf(sync, 'export class RoutingContext {', 'RoutingContext {');
  const outside = sync.replace(context, '');
  expect(outside).not.toMatch(/\bprefixEvidence\b/);
  for (const [file, text] of workerCode) if (file !== 'worker/sync.ts') expect(text, file).not.toMatch(/\bprefixEvidence\b/);
  // knownPrefixEvidence is handed only from options() to the router (audit P6).
  expect(outside).not.toMatch(/\bknownPrefixEvidence\b/);
  for (const [file, text] of workerCode) if (file !== 'worker/sync.ts') expect(text, file).not.toMatch(/\bknownPrefixEvidence\b/);
  // In src/, only the router reads it, and nothing there writes, logs or counts the ledger.
  const srcFiles = readdirSync('src', { recursive: true, encoding: 'utf8' })
    .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f))
    .map((f) => path.join('src', f));
  const readers = srcFiles.filter((f) => /\b(knownPrefixEvidence|PrefixLedger|PrefixEvidence|notePrefixEvidence)\b/.test(code(f)));
  expect(readers).toEqual([path.join('src', 'lib', 'discovery', 'route', 'firmRules.ts')]);
  const router = code(path.join('src', 'lib', 'discovery', 'route', 'firmRules.ts'));
  expect(router).not.toMatch(/console\.|logger\.|\.from\(|\.rpc\(/);
});
