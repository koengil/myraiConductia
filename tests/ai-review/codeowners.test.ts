import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { loadConfig, matchesGlob } from '../../scripts/ai-review/router';

const { fence } = loadConfig('.github/ai-review');

// First token of every non-comment CODEOWNERS line, skipping the catch-all `*`.
const owners = readFileSync('.github/CODEOWNERS', 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '' && !line.startsWith('#'))
  .map((line) => line.split(/\s+/)[0])
  .filter((pattern) => pattern !== '*');

// Strip a leading slash; a trailing slash means the whole directory.
function normalize(pattern: string): string {
  const bare = pattern.startsWith('/') ? pattern.slice(1) : pattern;
  return bare.endsWith('/') ? `${bare}**` : bare;
}

function isFenced(pattern: string): boolean {
  const normalized = normalize(pattern);
  if (normalized.endsWith('/**')) {
    // The whole directory must be fenced: a `dir/**` glob on it or on an ancestor, not a narrower pattern inside it.
    const dir = normalized.slice(0, -2);
    return fence.paths.some((glob) => glob.endsWith('/**') && dir.startsWith(glob.slice(0, -2)));
  }
  return fence.paths.some((glob) => matchesGlob(normalized, glob));
}

describe('CODEOWNERS paths are covered by the AI-review fence', () => {
  it('reads at least one owned path', () => {
    expect(owners.length).toBeGreaterThan(0);
  });

  it.each(owners)('fences %s', (pattern) => {
    expect(isFenced(pattern)).toBe(true);
  });
});
