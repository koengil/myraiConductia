// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every browser context in e2e/ must come from `newCollectedContext`
 * (e2e/support/cspViolations.ts), because that is what installs the
 * Content-Security-Policy violation collector. A raw `browser.newContext(`
 * opens a context whose violations nobody reads, so a CSP break on those pages
 * would pass the suite. The test fails on the call, not on a convention.
 *
 * `playwrightRequest.newContext(` opens an API request context: no pages, no
 * CSP. It is ignored.
 */

const E2E_DIR = path.join(__dirname, '..', 'e2e');
const HELPER = path.join('e2e', 'support', 'cspViolations.ts');

/** API request contexts have no pages, so no CSP. */
const REQUEST_RECEIVERS = new Set(['playwrightRequest', 'request']);

/** Calls that open a page-bearing browser context without the collector. */
function rawBrowserContextCalls(source: string): string[] {
  const hits: string[] = [];
  source.split('\n').forEach((line, index) => {
    const code = line.trim();
    if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return;
    const newContexts = [...line.matchAll(/([\w$.()!]*)\.newContext\s*\(/g)];
    const rawContext = newContexts.some((m) => !REQUEST_RECEIVERS.has(m[1]));
    // browser.newPage() opens a context of its own; newPage() on a collected context does not.
    const rawPage = /\bbrowser\.newPage\s*\(/.test(line);
    const rawPersistent = /\blaunchPersistentContext\s*\(/.test(line);
    if (rawContext || rawPage || rawPersistent) hits.push(`line ${index + 1}: ${code}`);
  });
  return hits;
}

function listTs(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '.state' || entry.name === 'node_modules' ? [] : listTs(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

describe('rawBrowserContextCalls (the detector)', () => {
  it.each([
    ['browser.newContext(', 'const c = await browser.newContext({ baseURL });'],
    ['a browser on another name', 'const c = await b.newContext();'],
    ['context.browser()', 'const c = await context.browser()!.newContext();'],
    ['browser.newPage(', 'const p = await browser.newPage();'],
    ['launchPersistentContext(', 'await chromium.launchPersistentContext(dir);'],
  ])('flags %s', (_, line) => {
    expect(rawBrowserContextCalls(line)).toHaveLength(1);
  });

  it.each([
    ['playwrightRequest.newContext(', 'const api = await playwrightRequest.newContext({ baseURL });'],
    ['request.newContext(', 'const api = await request.newContext({ baseURL });'],
    ['the sanctioned helper', 'const c = await newCollectedContext(browser, { baseURL });'],
    ['a collected context opening a page', 'const p = await memberContext.newPage();'],
    ['a line comment', '  // a bare browser.newContext() would skip the collector'],
    ['a block comment line', '   * browser.newContext() falls back to the project default'],
  ])('ignores %s', (_, line) => {
    expect(rawBrowserContextCalls(line)).toEqual([]);
  });
});

describe('e2e/ opens browser contexts only through newCollectedContext', () => {
  it('has no raw browser context call outside the helper', () => {
    const offenders = listTs(E2E_DIR)
      .filter((file) => !file.endsWith(HELPER))
      .flatMap((file) =>
        rawBrowserContextCalls(fs.readFileSync(file, 'utf8')).map(
          (hit) => `${path.relative(path.join(__dirname, '..'), file)} ${hit}`,
        ),
      );
    expect(offenders, 'use newCollectedContext(browser, options) from e2e/support/cspViolations.ts').toEqual([]);
  });

  it('actually scans the e2e tree', () => {
    const files = listTs(E2E_DIR).map((f) => path.relative(E2E_DIR, f));
    expect(files).toContain(path.join('support', 'fixtures.ts'));
    expect(files).toContain(path.join('support', 'cspViolations.ts'));
    expect(files.filter((f) => f.startsWith('journeys')).length).toBeGreaterThan(15);
  });
});
