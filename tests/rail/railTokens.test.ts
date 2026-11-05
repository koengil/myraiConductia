import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * Rail surfaces use the design tokens, not Tailwind defaults (S6 round 1):
 * shadows come from the elevation tokens and ink on a dark fill is
 * --ink-on-dark.
 */

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

/** Every source file under src/components/rail/, nested folders included. */
function railFiles(dir = join(process.cwd(), 'src/components/rail')): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return railFiles(path);
    return /\.(tsx?|jsx?)$/.test(entry.name) ? [relative(process.cwd(), path)] : [];
  });
}

describe('rail token use', () => {
  it('the template step-gap "+" uses the token shadow, not shadow-sm (S6-20)', () => {
    const panel = source('src/app/(authed)/rail-templates/TemplateDetailPanel.tsx');
    expect(panel).not.toMatch(/\bshadow-sm\b/);
    expect(panel).toMatch(/aria-label="Add a step here"[\s\S]*?shadow-\[var\(--elev-2\)\]/);
  });

  it.each([
    'src/components/rail/RemoveStepControl.tsx',
    'src/app/(authed)/rail-templates/TemplateDialogs.tsx',
    'src/components/rail/RailBoard.tsx',
    'src/components/rail/StepCard.tsx',
  ])('%s sets ink on a dark fill with --ink-on-dark, never text-white (S6-21)', (path) => {
    const text = source(path);
    expect(text).not.toMatch(/\btext-white\b/);
    expect(text).toContain('text-[var(--ink-on-dark)]');
  });

  it('the guard sees every rail file', () => {
    const files = railFiles();
    expect(files).toContain('src/components/rail/DealRail.tsx');
    expect(files).toContain('src/components/rail/review/RunOutput.tsx');
  });

  it.each(railFiles())('%s never sets text-white: ink on a dark fill is --ink-on-dark (S6R3-09)', (path) => {
    expect(source(path)).not.toMatch(/\btext-white\b/);
  });

  it.each([
    'src/components/shell/AppNav.tsx',
    'src/components/notifications/NavCountBadge.tsx',
    'src/components/workspace/commandCenter/DealsTable.tsx',
  ])('%s sets 10px and 11px type with the --text-xxs / --text-xs tokens (S6R3-09)', (path) => {
    expect(source(path)).not.toMatch(/\btext-\[(length:)?1[01]px\]/);
  });
});
