import { describe, expect, it } from 'vitest';

import {
  categoryColorForFolder,
  categoryColorForLabel,
  DEAL_FOLDER_COLORS,
} from '@/lib/dataroom/categoryColors';
import { DEAL_FOLDER_LABELS, DEAL_FOLDERS } from '@/lib/dataroom/taxonomy';

describe('Deal Folder category colours', () => {
  it('gives each of the eight folders its own colour', () => {
    const dots = DEAL_FOLDERS.map((folder) => DEAL_FOLDER_COLORS[folder].dot);
    expect(new Set(dots).size).toBe(8);
  });

  it('uses only Workbench tokens, never a raw hex value or the AI violet', () => {
    for (const folder of DEAL_FOLDERS) {
      const { dot, fill } = DEAL_FOLDER_COLORS[folder];
      expect(dot).not.toMatch(/#[0-9a-f]{3,8}/i);
      expect(fill).not.toMatch(/#[0-9a-f]{3,8}/i);
      expect(dot).not.toContain('--ai');
    }
  });

  it('finds a colour by display label and by stored id, and nothing for anything else', () => {
    expect(categoryColorForLabel(DEAL_FOLDER_LABELS.buyers)).toEqual(DEAL_FOLDER_COLORS.buyers);
    expect(categoryColorForFolder('closing')).toEqual(DEAL_FOLDER_COLORS.closing);
    expect(categoryColorForLabel('NDA')).toBeNull();
    expect(categoryColorForFolder('nope')).toBeNull();
    expect(categoryColorForFolder(undefined)).toBeNull();
  });

  it('uses the Workbench pastel fill tokens and keeps Admin and Closing apart', () => {
    expect(DEAL_FOLDER_COLORS['client-presentations'].fill).toBe('var(--positive-fill)');
    expect(DEAL_FOLDER_COLORS['marketing-materials'].fill).toBe('var(--hold-fill)');
    expect(DEAL_FOLDER_COLORS.buyers.fill).toBe('var(--negative-fill)');
    expect(DEAL_FOLDER_COLORS.admin.fill).not.toBe(DEAL_FOLDER_COLORS.closing.fill);
    expect(DEAL_FOLDER_COLORS.admin.dot).not.toBe(DEAL_FOLDER_COLORS.closing.dot);
  });

  // 01 and 07 each take their own pastel token, so they never share a grey.
  it('gives Admin and Closing distinct pastel tokens, only one of them grey', () => {
    expect(DEAL_FOLDER_COLORS.admin.fill).toBe('var(--accent-soft)');
    expect(DEAL_FOLDER_COLORS.closing.fill).toBe('var(--surface-subtle)');
    expect(DEAL_FOLDER_COLORS.admin.fill).toMatch(/^var\(--[a-z-]+\)$/);
    expect(DEAL_FOLDER_COLORS.closing.fill).toMatch(/^var\(--[a-z-]+\)$/);
  });
});
