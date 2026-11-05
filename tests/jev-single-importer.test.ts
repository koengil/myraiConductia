// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { walk } from './helpers/walkRepo';

/*
 * The Jev client (src/lib/ai/jev.ts) sends email text to a new processor.
 * In the app it is reached through ONE seam, src/lib/compliance/secondOpinion.ts,
 * whose jevCallAllowed decides whether a call may happen at all (D82: off by
 * default; PR #346's model gate replaces that check). Nothing else under src/
 * or worker/ may import the client. Martín's review of PR #423 made the client
 * script-only; this keeps its intent now that the send path can use it.
 */

const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

describe('the Jev client has one importer in the app', () => {
  const files = ['src', 'worker'].flatMap((dir) => walk(dir)).filter((f) => /\.(?:[cm]?[jt]sx?)$/.test(f));

  it('scans the app', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('is imported only by the second-opinion seam', () => {
    const importers = files.filter((file) =>
      [...readFileSync(join(process.cwd(), file), 'utf8').matchAll(IMPORT_RE)].some((m) => /(?:^|\/)jev(?:\.[cm]?[jt]sx?)?$/.test(m[1])),
    );
    expect(importers.map((f) => f.split('\\').join('/'))).toEqual(['src/lib/compliance/secondOpinion.ts']);
  });
});
