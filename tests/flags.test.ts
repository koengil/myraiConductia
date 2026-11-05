import { describe, it, expect, vi } from 'vitest';
import { isEnabled } from '@/lib/flags/isEnabled';
import type { FlagSource } from '@/lib/flags/source';
import type { FlagKey } from '@/lib/flags/keys';

const sourceReturning = (value: boolean | null): FlagSource => ({
  getEnabled: async () => value,
});

const throwingSource: FlagSource = {
  getEnabled: async () => {
    throw new Error('db unreachable');
  },
};

const KEY: FlagKey = 'gate0_api_create';

describe('isEnabled (fail-closed flag resolution)', () => {
  it('returns true only when the source explicitly returns true', async () => {
    expect(await isEnabled(KEY, sourceReturning(true))).toBe(true);
  });

  it('returns false when the source returns false', async () => {
    expect(await isEnabled(KEY, sourceReturning(false))).toBe(false);
  });

  it('fails closed when the flag has no row (null)', async () => {
    expect(await isEnabled(KEY, sourceReturning(null))).toBe(false);
  });

  it('fails closed and warns when the source throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await isEnabled(KEY, throwingSource)).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
