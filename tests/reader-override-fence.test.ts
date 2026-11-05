// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { walk } from './helpers/walkRepo';

/**
 * Confines the worker's `readerFor` override (#263, design R1). An override
 * replaces the inner reader per source, and the guard wrapper checks that an
 * exclusion policy exists, not what the reader yields: an override that ignored a
 * non-empty policy would hand back excluded messages in full. So the worker refuses
 * an override under a non-empty Gmail policy at run time, and this test keeps the
 * list of callers short: production code never passes `readerFor`. Only the
 * worker's own forwarding (worker/classify.ts: startWorker to createWorkerHandlers)
 * and the Graph cassette replay script (scripts/m365/replay-discovery.ts, Microsoft
 * only, which the wrapper refuses under a policy) may. Tests are outside the fence.
 */

const ROOT = process.cwd();
const ALLOWED = new Set(['worker/classify.ts', 'scripts/m365/replay-discovery.ts']);
const PRODUCTION_ROOTS = ['src', 'worker', 'scripts', 'e2e'];

/** Where a `readerFor` property is given a value (`readerFor: x` or the shorthand `{ readerFor }`) in an object literal. */
export function readerOverridesIn(text: string, fileName = 'x.ts'): number[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const lines: number[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && node.name.getText(sf).replace(/['"]/g, '') === 'readerFor') {
      lines.push(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return lines;
}

/**
 * Every place the name `readerFor` appears in code, as an identifier or a string (comments do not count). Stricter
 * than readerOverridesIn: it also catches `options.readerFor = x`, `o['readerFor'] = x`, a computed key, and an
 * options object built elsewhere and spread in, since setting the property anywhere means writing its name.
 */
export function readerForMentionsIn(text: string, fileName = 'x.ts'): number[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const lines: number[] = [];
  const visit = (node: ts.Node) => {
    const named =
      ((ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) && node.text === 'readerFor') ||
      ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text === 'readerFor');
    if (named) lines.push(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return lines;
}

describe('the readerFor override is confined (#263)', () => {
  const files = PRODUCTION_ROOTS.flatMap((root) => walk(root)).filter((file) => /\.(ts|tsx|mts|js|mjs|cjs)$/.test(file));

  it('is passed only by the worker itself and the Graph cassette replay script, in production code', () => {
    expect(files.length).toBeGreaterThan(100);
    const offenders = files
      .filter((file) => !ALLOWED.has(file))
      .filter((file) => readerOverridesIn(readFileSync(join(ROOT, file), 'utf8'), file).length > 0);
    expect(offenders, 'a production caller passes readerFor: tests may, production code may not').toEqual([]);
  });

  it('is not even named in production code outside those two files: no assignment, computed key or spread can set it', () => {
    const offenders = files
      .filter((file) => !ALLOWED.has(file))
      .filter((file) => readerForMentionsIn(readFileSync(join(ROOT, file), 'utf8'), file).length > 0);
    expect(offenders, 'only worker/classify.ts and the Graph cassette replay script may name readerFor in code').toEqual([]);
  });

  it('names the property in code, however it is written, and not in a comment or a longer string', () => {
    expect(readerForMentionsIn('options.readerFor = myReader;')).toEqual([1]);
    expect(readerForMentionsIn("options['readerFor'] = myReader;")).toEqual([1]);
    expect(readerForMentionsIn("f({ ['readerFor']: x });")).toEqual([1]);
    expect(readerForMentionsIn('const key = `readerFor`;\nf({ [key]: x });')).toEqual([1]);
    expect(readerForMentionsIn('const extra = { readerFor: x };\nrunOnce({ tenantId, ...extra });')).toEqual([1]);
    expect(readerForMentionsIn("// readerFor: documented here\nconst s = 'readerFor: text';")).toEqual([]);
  });

  it('still finds the two allowed callers, so the scan is not blind', () => {
    for (const file of ALLOWED) {
      expect(readerOverridesIn(readFileSync(join(ROOT, file), 'utf8'), file).length, file).toBeGreaterThan(0);
    }
  });

  it('detects the property, quoted, shorthand and nested, and not a mere mention', () => {
    expect(readerOverridesIn("runOnce({ tenantId, readerFor: myReader });")).toEqual([1]);
    expect(readerOverridesIn("const readerFor = x;\nstartWorker({ db, readerFor });")).toEqual([2]);
    expect(readerOverridesIn("f({ 'readerFor': x });")).toEqual([1]);
    expect(readerOverridesIn("f({ options: { readerFor: x } });")).toEqual([1]);
    expect(readerOverridesIn("// readerFor: documented here\nconst s = 'readerFor: text'; options.readerFor(source);")).toEqual([]);
  });
});
