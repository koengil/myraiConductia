import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  DEAL_LIST_UNAVAILABLE_COPY,
  DEALS_UNAVAILABLE_SHORT_COPY,
  TRY_AGAIN_COPY,
} from '@/components/deals/DealsUnavailable';
import { railLoadCopy } from '@/lib/rail/railLoadStage';

/**
 * #162 Phase 3: the rail's staged waiting copy and the deal-list unavailable
 * copy stay in the house voice. Statements, not questions; no em dash in
 * visible copy (brand-spirit.md, CLAUDE.md). Mechanical, so a later edit
 * cannot drift past review.
 */

const STAGED = [
  railLoadCopy({ pending: 'deals', slow: false }),
  railLoadCopy({ pending: 'rail', slow: false }),
  railLoadCopy({ pending: 'deals', slow: true }),
  railLoadCopy({ pending: 'rail', slow: true }),
];

/** Quoted strings in a source file that read as copy (both quote styles). */
function quotedCopy(path: string): string[] {
  const source = readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('import '))
    .filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*'))
    .join('\n');
  const quoted = source.match(/(['"])[^'"\n]{12,}\1/g) ?? [];
  return quoted
    .map((s) => s.slice(1, -1))
    .filter((s) => /[a-z]/.test(s) && /\s/.test(s))
    .filter((s) => !s.includes('var(--') && !s.includes('/'));
}

/** JSX text the rail renders around its gate (between a tag's > and the next <). */
function jsxText(path: string): string[] {
  const source = readFileSync(path, 'utf8');
  const texts = source.match(/>\s*([A-Z][^<>{}]*[.…])\s*</g) ?? [];
  return texts.map((t) => t.replace(/^>\s*|\s*<$/g, '').replace(/\s+/g, ' '));
}

const ALL = [
  ...STAGED,
  DEAL_LIST_UNAVAILABLE_COPY,
  DEALS_UNAVAILABLE_SHORT_COPY,
  TRY_AGAIN_COPY,
  ...quotedCopy('src/lib/rail/railLoadStage.ts'),
  ...quotedCopy('src/components/deals/DealsUnavailable.tsx'),
  ...jsxText('src/components/rail/DealRail.tsx'),
];

describe('rail loading and deal-list unavailable copy (#162)', () => {
  it('reads the copy it guards', () => {
    expect(ALL).toContain('The deal rail could not be loaded right now.');
    expect(ALL).toContain('Loading your deal list…');
    expect(ALL).toContain('Still loading the deal rail. This is taking longer than usual.');
  });

  it('uses no em dash', () => {
    expect(ALL.filter((s) => s.includes('—'))).toEqual([]);
  });

  it('states rather than asks', () => {
    expect(ALL.filter((s) => s.trim().endsWith('?'))).toEqual([]);
  });

  it('is sentence case', () => {
    const copy = [...STAGED, DEAL_LIST_UNAVAILABLE_COPY, DEALS_UNAVAILABLE_SHORT_COPY];
    for (const sentence of copy.flatMap((s) => s.split(/(?<=\.)\s+/))) {
      expect(sentence[0]).toBe(sentence[0].toUpperCase());
      expect(sentence.slice(1)).toBe(sentence.slice(1).toLowerCase());
    }
  });
});
