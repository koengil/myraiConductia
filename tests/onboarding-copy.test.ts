import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Criterion D6: the visible copy this work adds is in Conductia's voice —
 * statements not questions, and no em-dashes (the house rule; ARIA and
 * regulatory separators are the documented exception, and none of these files
 * use one).
 *
 * A review gate would be forgettable, so this is mechanical: it reads the
 * source of the three new components and the strings they render.
 */
const SURFACES = [
  'src/components/onboarding/SmartLookupCard.tsx',
  'src/components/onboarding/PerimeterPreview.tsx',
  'src/components/onboarding/WelcomeBrief.tsx',
];

/** Quoted strings that are user-visible: skips imports, testids and aria keys. */
function visibleStrings(source: string): string[] {
  const withoutImports = source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('import '))
    .filter((line) => !line.includes('data-testid'))
    .join('\n');
  const quoted = withoutImports.match(/'[^'\n]{12,}'/g) ?? [];
  return quoted
    .map((s) => s.slice(1, -1))
    .filter((s) => /[a-z]/.test(s))
    .filter((s) => !s.includes('/')) // paths and URLs
    .filter((s) => !/^[a-z_]+$/.test(s)); // stable ids like external_never_mnpi
}

describe('onboarding copy stays in voice (D6)', () => {
  for (const path of SURFACES) {
    it(`${path} uses no em-dash in visible copy`, () => {
      const source = readFileSync(path, 'utf8');
      const offenders = visibleStrings(source).filter((s) => s.includes('—'));
      expect(offenders).toEqual([]);
    });

    it(`${path} states rather than asks`, () => {
      const source = readFileSync(path, 'utf8');
      const questions = visibleStrings(source).filter((s) => s.trim().endsWith('?'));
      expect(questions).toEqual([]);
    });
  }

  it('names the proposal as a proposal, so nothing reads as already granted', () => {
    const card = readFileSync('src/components/onboarding/SmartLookupCard.tsx', 'utf8');
    expect(card).toMatch(/proposal/i);
  });
});
