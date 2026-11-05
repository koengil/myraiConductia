import { describe, expect, it, vi } from 'vitest';
import { resolveSetupActor } from '@/lib/api/v1/setupWalkthroughs';

function adminFor(row: Record<string, unknown> | null, rpcResult = false) {
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  for (const method of ['select', 'eq']) builder[method] = chain;
  builder.maybeSingle = () => Promise.resolve({ data: row, error: null });
  return {
    from: vi.fn(() => builder),
    rpc: vi.fn(() => Promise.resolve({ data: rpcResult, error: null })),
  };
}

describe('resolveSetupActor', () => {
  it('gives active users the user track and protected roots the administrator track', async () => {
    const regular = adminFor({
      firm_role: null,
      company_id: null,
      company_role: null,
      is_external: true,
      status: 'active',
    });
    const root = adminFor({
      firm_role: 'admin',
      company_id: null,
      company_role: null,
      is_external: false,
      status: 'active',
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await resolveSetupActor(regular as any, 'u-1')).toMatchObject({ tracks: ['user'] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await resolveSetupActor(root as any, 'u-2')).toMatchObject({
      tracks: ['user', 'administrator'],
    });
  });

  it('allows only delegated access managers onto the administrator track', async () => {
    const delegate = adminFor(
      {
        firm_role: null,
        company_id: 'c-1',
        company_role: 'member',
        is_external: false,
        status: 'active',
      },
      true,
    );
    const member = adminFor(
      {
        firm_role: null,
        company_id: 'c-1',
        company_role: 'member',
        is_external: false,
        status: 'active',
      },
      false,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await resolveSetupActor(delegate as any, 'u-1')).toMatchObject({
      tracks: ['user', 'administrator'],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await resolveSetupActor(member as any, 'u-2')).toMatchObject({ tracks: ['user'] });
  });

  it('gives external company directors the administrator track', async () => {
    const director = adminFor({
      firm_role: null,
      company_id: 'co-playboot',
      company_role: 'director',
      is_external: true,
      status: 'active',
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await resolveSetupActor(director as any, 'u-1')).toMatchObject({
      tracks: ['user', 'administrator'],
    });
  });

  it('rejects suspended users', async () => {
    const admin = adminFor({
      firm_role: null,
      company_id: null,
      company_role: null,
      is_external: false,
      status: 'suspended',
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await resolveSetupActor(admin as any, 'u-1')).toEqual({
      ok: false,
      reason: 'not_eligible',
    });
  });
});
