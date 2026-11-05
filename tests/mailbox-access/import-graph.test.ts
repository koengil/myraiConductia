// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { importsOf, moduleReferencesOf } from '../helpers/importGraph';

/*
 * The import graph behind boot-claim.test.ts must see every static load (#262,
 * audit round 3, item 4). `import x = require('./y')` is a load that is neither an
 * ImportDeclaration nor a call expression, so the graph ignored it and an entry
 * point could reach the readers module (or reorder its first import) unseen.
 */
describe('importGraph reads import-equals as a static load', () => {
  it('lists `import x = require()` with its specifier and line', () => {
    const edges = importsOf('scripts/x.ts', "import a = require('./a');\nimport b = require('@/lib/b');\n");
    expect(edges).toEqual([
      { specifier: './a', kind: 'static', line: 1 },
      { specifier: '@/lib/b', kind: 'static', line: 2 },
    ]);
  });

  it('keeps source order, so an import-equals can be (or displace) the first import', () => {
    const edges = importsOf('scripts/x.ts', "import a = require('@/lib/mailboxAccess/readers');\nimport { b } from './b';\n");
    expect(edges.map((e) => e.specifier)).toEqual(['@/lib/mailboxAccess/readers', './b']);
  });

  it('reads an exported import-equals too', () => {
    expect(importsOf('scripts/x.ts', "export import a = require('./a');").map((e) => e.specifier)).toEqual(['./a']);
  });

  it('skips a type-only import-equals and an entity alias (neither loads a module)', () => {
    expect(importsOf('scripts/x.ts', "import type a = require('./a');\nimport n = Some.Namespace;\n")).toEqual([]);
  });

  it('reports type-only status for the fence, which allows type imports', () => {
    const refs = moduleReferencesOf('x.ts', "import type a = require('./a');\nimport { type T } from './t';\nimport { v, type U } from './v';\nimport './side';\n");
    expect(refs.map((r) => [r.specifier, r.typeOnly])).toEqual([
      ['./a', true],
      ['./t', true],
      ['./v', false],
      ['./side', false],
    ]);
  });
});
