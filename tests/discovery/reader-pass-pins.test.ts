// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';

// The reader pass record (#370, R1-m6, R2-m8): every read runs under a pass. syncSource is the one function that
// reads a source, so it may be called only from readOneSource, and readOneSource only under runPass, from the queue
// handler's attempt() and from runOnce. A source-text pin, in the style of the fence tests: comment lines are
// stripped first (worker/sync.ts mentions `syncSource(` in its header), and function bodies are sliced by brace
// counting, so an "inside" assertion cannot pass vacuously.

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

const CALL = (name: string) => new RegExp(`(?<!function )\\b${name}\\(`, 'g');
const sourceFiles = ['src', 'worker', 'scripts'].flatMap((root) =>
  readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((f) => /\.(ts|tsx|mjs)$/.test(f))
    .map((f) => path.join(root, f)),
);

it('syncSource is called only from worker/classify.ts, once, inside readOneSource', () => {
  expect(sourceFiles.filter((f) => new RegExp(CALL('syncSource')).test(code(f)))).toEqual(['worker/classify.ts']);
  const classify = code('worker/classify.ts');
  expect(classify.match(CALL('syncSource'))).toHaveLength(1);
  const body = bodyOf(classify, 'async function readOneSource(', 'Promise<SourceOutcome> {');
  expect(body.match(CALL('syncSource'))).toHaveLength(1);
});

it('readOneSource runs only under runPass', () => {
  expect(sourceFiles.filter((f) => new RegExp(CALL('readOneSource')).test(code(f)))).toEqual(['worker/classify.ts']);
  const classify = code('worker/classify.ts');
  expect(classify.match(CALL('readOneSource'))).toHaveLength(2); // attempt() and runOnce
  expect(classify).toMatch(/runPass\(\s*pass\s*,\s*\(\)\s*=>\s*attempt\(/); // the handler
  expect(classify).toMatch(/runPass\(\s*[^,]+,\s*\(\)\s*=>\s*readOneSource\(/); // runOnce
  const attempt = bodyOf(classify, 'async function attempt(', 'Promise<SyncJobResult> {');
  expect(attempt.match(CALL('readOneSource'))).toHaveLength(1);
  // attempt() itself runs only under the handler's pass.
  expect(classify.match(CALL('attempt'))).toHaveLength(1);
});

it('the handler starts its pass before anything else it does', () => {
  const classify = code('worker/classify.ts');
  const sync = bodyOf(classify, 'async sync(data, meta = {})', ') {');
  const statements = sync.slice(1, -1).trim();
  expect(statements).toMatch(/^const pass = await beginPass\(/);
});

// The team inbox check (#581, design R7; audit item 10): a team source's address is checked against the Google
// Directory before any read, from both entry points, and before the provider group it is compared in is read, so a
// registration verified this tick is in allowed_team_mailboxes when the group is compared. checkTeamSources is the one
// caller of the check, and only a source that belongs to a registration is checked.
it('the team inbox check runs once, in checkTeamSources, for a team source only', () => {
  expect(sourceFiles.filter((f) => new RegExp(CALL('checkTeamMailbox')).test(code(f)))).toEqual(['worker/classify.ts']);
  const classify = code('worker/classify.ts');
  expect(classify.match(CALL('checkTeamMailbox'))).toHaveLength(1);
  const helper = bodyOf(classify, 'async function checkTeamSources(', 'Promise<void> {');
  expect(helper).toMatch(/if \(source\.teamMailboxId\) await checkTeamMailbox\(/);
  // readOneSource no longer checks: by the time it runs, the group was read with the check's outcome.
  const read = bodyOf(classify, 'async function readOneSource(', 'Promise<SourceOutcome> {');
  expect(read).not.toMatch(CALL('checkTeamMailbox'));
  expect(read).not.toMatch(CALL('checkTeamSources'));
});

it('both entry points check their team sources before the provider group is read, and before any reader', () => {
  const classify = code('worker/classify.ts');
  const runOnce = bodyOf(classify, 'export async function runOnce(', 'Promise<RunSummary> {');
  const attempt = bodyOf(classify, 'async function attempt(', 'Promise<SyncJobResult> {');
  for (const [name, body] of [['runOnce', runOnce], ['attempt', attempt]] as const) {
    expect(body.match(CALL('checkTeamSources')), name).toHaveLength(1);
    const gate = body.indexOf('checkTeamSources(');
    expect(body.indexOf('providerPass('), name).toBeGreaterThan(gate);
    expect(body.indexOf('readOneSource('), name).toBeGreaterThan(gate);
    expect(body, name).toMatch(/checkTeamSources\([^;]*options\.teamVerifier\)/);
    expect(body, name).toMatch(/teamVerifier:\s*options\.teamVerifier/);
  }
  // attempt checks after its halt and registration checks: a halted or unregistered source is never checked.
  expect(attempt.indexOf('isHalted(')).toBeLessThan(attempt.indexOf('checkTeamSources('));
  expect(attempt.indexOf('REGISTRATION_INACTIVE')).toBeLessThan(attempt.indexOf('checkTeamSources('));
});

// The mid-pass renewal (#581, design R7): the guarded reader may renew a stale team confirmation once, between pages.
// readOneSource hands it over as a closure on the context, for a team source only; nothing else calls it, and it never
// stands in for the guard.
it('the mid-pass renewal is built once, inside readOneSource, for a team source only, and goes into the reader context', () => {
  expect(sourceFiles.filter((f) => new RegExp(CALL('recheckTeamMailbox')).test(code(f)))).toEqual(['worker/classify.ts']);
  const classify = code('worker/classify.ts');
  expect(classify.match(CALL('recheckTeamMailbox'))).toHaveLength(1);
  const body = bodyOf(classify, 'async function readOneSource(', 'Promise<SourceOutcome> {');
  expect(body.match(CALL('recheckTeamMailbox'))).toHaveLength(1);
  expect(body).toMatch(/const recheckTeam = a\.source\.teamMailboxId\s*\?\s*\(\) => recheckTeamMailbox\(/);
  // It reaches the reader through the guarded context, and the sync never sees it.
  expect(body).toMatch(/ctx: \{ \.\.\.pass\.ctx, onProgress, recheckTeam, \.\.\.claim \}/);
  // After the halt check (the start-of-pass check ran before the group, checkTeamSources) and before the reader.
  expect(body.indexOf('recheckTeam =')).toBeGreaterThan(body.indexOf('haltedNow('));
  expect(body.indexOf('recheckTeam =')).toBeLessThan(body.indexOf('guardedReaderFor('));
  // Neither entry point calls it: they only reach readOneSource.
  const runOnce = bodyOf(classify, 'export async function runOnce(', 'Promise<RunSummary> {');
  const attempt = bodyOf(classify, 'async function attempt(', 'Promise<SyncJobResult> {');
  expect(runOnce).not.toMatch(CALL('recheckTeamMailbox'));
  expect(attempt).not.toMatch(CALL('recheckTeamMailbox'));
});

it('the guarded reader is the only caller of the renewal it is handed, and it asks the guard again right after', () => {
  const readers = code('src/lib/mailboxAccess/readers.ts');
  const calls = readers.match(/ctx\.recheckTeam\(\)/g) ?? [];
  expect(calls).toHaveLength(1);
  const between = bodyOf(readers, 'const assertBetweenPages = async (source: SourceRow) =>', '=> {');
  // Renew, then ask the guard: the renewal's own return is never read as an answer.
  expect(between).toMatch(/await ctx\.recheckTeam\(\);\s*await assertSource\(source\);/);
  expect(between).not.toMatch(/=\s*await ctx\.recheckTeam\(\)/);
  // Only the page-to-page position is renewable: the first assertion in guarded() is the plain one, carrying only
  // #275's binding step (hooks.bind), which runs inside that first guard call.
  const guarded = bodyOf(readers, 'async function* guarded(', 'fromNothing = false) {');
  // The first call asserts this read's tagged copy (#643, #667 review): its token binds the key for this read alone.
  expect(guarded.match(/await assertSource\((?:source|tagged)(?:, hooks\.bind)?\);/g)).toHaveLength(1);
  expect(guarded).toMatch(/const tagged: ReadSource = \{ \.\.\.source, \[READ\]: \{\} \};\s*await assertSource\(tagged, hooks\.bind\);/);
  expect(guarded).toMatch(/await assertBetweenPages\(source\);/);
  expect(guarded.indexOf('await assertSource(tagged, hooks.bind);')).toBeLessThan(guarded.indexOf('open(read)'));
});
