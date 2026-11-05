import { describe, it, expect, vi } from 'vitest';
import { resolveFlags, type FlagsFetcher } from '@/lib/flags/resolveFlags';

describe('resolveFlags (fail-closed snapshot)', () => {
  it('maps a stored enabled=true to true', async () => {
    const fetcher: FlagsFetcher = async () => [
      { key: 'gate0_api_create', enabled: true },
    ];
    const flags = await resolveFlags(fetcher);
    expect(flags.gate0_api_create).toBe(true);
  });

  it('defaults a registered flag with no row to false', async () => {
    const fetcher: FlagsFetcher = async () => [];
    const flags = await resolveFlags(fetcher);
    expect(flags.gate0_api_create).toBe(false);
  });

  it('fails closed (false) and warns when the fetcher throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetcher: FlagsFetcher = async () => {
      throw new Error('db down');
    };
    const flags = await resolveFlags(fetcher);
    expect(flags.gate0_api_create).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('ignores keys returned by the fetcher that are not in the registry', async () => {
    const fetcher: FlagsFetcher = async () => [
      { key: 'not_a_real_flag', enabled: true },
    ];
    const flags = await resolveFlags(fetcher);
    expect((flags as Record<string, boolean>).not_a_real_flag).toBeUndefined();
  });
});
