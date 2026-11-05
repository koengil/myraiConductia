import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { LENSES } from '../../scripts/ai-review/findings';
import { loadConfig } from '../../scripts/ai-review/router';

const DIR = '.github/ai-review';
const { profiles, fence } = loadConfig(DIR);
const validGlob = (g: string) => g.length > 0 && !g.startsWith('/') && !g.includes('***') && !g.includes('\\');

describe('ai-review config', () => {
  it('defines exactly the known lenses, each with a prompt file and both phase models', () => {
    expect(Object.keys(profiles.lenses).sort()).toEqual([...LENSES].sort());
    for (const lens of LENSES) {
      const p = profiles.lenses[lens];
      expect(existsSync(`${DIR}/prompts/${lens}.md`)).toBe(true);
      expect(p.model.trial).toBeTruthy();
      expect(p.model.production).toBeTruthy();
    }
    expect(profiles.lenses.generalist.always).toBe(true);
    expect(profiles.small_pr_max_lines).toBe(50);
  });

  it('ships the validator and evaluator prompts', () => {
    expect(existsSync(`${DIR}/prompts/validator.md`)).toBe(true);
    expect(existsSync(`${DIR}/prompts/evaluator.md`)).toBe(true);
  });

  it('uses valid glob patterns in profiles and fence', () => {
    const globs = [...fence.paths, ...LENSES.flatMap((l) => profiles.lenses[l].paths)];
    expect(fence.paths.length).toBeGreaterThan(0);
    for (const g of globs) expect(validGlob(g), g).toBe(true);
  });

  it('fences its own config', () => {
    expect(fence.paths).toContain('.github/ai-review/**');
  });
});
