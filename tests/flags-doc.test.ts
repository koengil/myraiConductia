import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { FLAG_REGISTRY } from '@/lib/flags/keys';

// The registry table in feature-flags.md lists exactly the keys in FLAG_REGISTRY.
it('documents every registry flag, and only those, in feature-flags.md', () => {
  const doc = readFileSync('docs/03-engineering/feature-flags.md', 'utf8');
  const section = doc.split('## The registry today')[1]?.split('\n### ')[0] ?? '';
  const documented = [...section.matchAll(/^\| `([a-z0-9_]+)` \|/gm)].map((m) => m[1]).sort();
  expect(documented).toEqual(Object.keys(FLAG_REGISTRY).sort());
});
