import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The perimeter counts documents, so the tempting shortcut is to reach for the
 * storage seam while it is there. It must not: counting is a metadata question,
 * and touching storage would put Box (or the bucket fallback) on a read path
 * that has no business failing when Box is down.
 *
 * The behavioural evidence that upload and download still work is in
 * document-wall.test.ts and dataroom.test.ts, which exercise the predicates
 * this work re-typed. This file pins the structural half.
 */
describe('the perimeter never touches storage', () => {
  it('imports no storage module', () => {
    const source = readFileSync('src/lib/perimeter/perimeter.ts', 'utf8');
    const imports = source.split('\n').filter((line) => line.trimStart().startsWith('import '));
    expect(imports.filter((line) => /storage|box|bucket/i.test(line))).toEqual([]);
  });

  it('reads only the three policy fields it needs from documents', () => {
    const source = readFileSync('src/lib/perimeter/perimeter.ts', 'utf8');
    const select = source.match(/\.select\('([^']+)'\)/);
    expect(select?.[1]).toBe('room, classification, min_phase');
  });
});
