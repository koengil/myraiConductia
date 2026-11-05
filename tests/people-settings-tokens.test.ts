import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Settings and Profile size, round and colour from the design tokens, not
 * Tailwind's defaults (contrast contract: a dark fill takes --ink-on-dark).
 */
const FILES = ['src/app/(authed)/settings/page.tsx', 'src/app/(authed)/profile/ProfileView.tsx'];

const TAILWIND_DEFAULTS =
  /(?<![\w:[(-])(?:rounded-(?:sm|md|lg)|text-(?:xs|sm|base|lg|xl|2xl)|text-white|px-\d|py-\d|text-\[\d+px\])(?![\w-])/g;

describe('Settings and Profile use tokens', () => {
  it.each(FILES)('%s has no Tailwind default sizes, radii or white text', (file) => {
    const source = readFileSync(path.join(process.cwd(), file), 'utf8');
    expect(source.match(TAILWIND_DEFAULTS) ?? []).toEqual([]);
  });

  it('sizes the section links at --text-md, the Sidebar Settings row size (14px), not --text-sm (12px)', () => {
    const source = readFileSync(path.join(process.cwd(), 'src/app/(authed)/settings/page.tsx'), 'utf8');
    expect(source).toContain('py-[var(--space-2)] text-[length:var(--text-md)]');
    expect(source).not.toContain('text-[length:var(--text-sm)]');
  });
});
