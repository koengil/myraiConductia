import { describe, expect, it } from 'vitest';

import { resolveFixturePath } from '../../scripts/sandbox/seed-sandbox-firm';
import { assertSandboxSeedSupabaseTarget, PRODUCTION_SUPABASE_REF, refuseSandboxSeedInCi } from '../../scripts/sandbox/lib/seedGuard';
import { assertSameTenant, patchUserSeatDrift } from '../../scripts/sandbox/lib/seedSeats';
import supabaseClientAllowlist from '../fixtures/mailboxReaderFence/supabaseClients.json';

describe('sandbox seed guard (#746)', () => {
  it('allows the default dev project and hard-denies production ref', () => {
    const devUrl = 'https://sqyjqdjazefceixkjtdp.supabase.co';
    expect(assertSandboxSeedSupabaseTarget(devUrl, {})).toBe('sqyjqdjazefceixkjtdp');
    expect(() => assertSandboxSeedSupabaseTarget(`https://${PRODUCTION_SUPABASE_REF}.supabase.co`, {})).toThrow(
      /fsaucpwponmzajupvsey/,
    );
    expect(() =>
      assertSandboxSeedSupabaseTarget(devUrl, { EXPECT_SUPABASE_REF: PRODUCTION_SUPABASE_REF }),
    ).toThrow(/EXPECT_SUPABASE_REF must not be the production project/);
  });

  it('refuses production app env and custom domains', () => {
    expect(() =>
      assertSandboxSeedSupabaseTarget('https://sqyjqdjazefceixkjtdp.supabase.co', { NEXT_PUBLIC_APP_ENV: 'production' }),
    ).toThrow(/production app environment/);
    expect(() => assertSandboxSeedSupabaseTarget('https://db.example.com', {})).toThrow(/Target is supabase db/);
  });

  it('refuses --apply in CI', () => {
    expect(() => refuseSandboxSeedInCi(true, { CI: 'true' })).toThrow(/CI/);
    expect(() => refuseSandboxSeedInCi(false, { CI: 'true' })).not.toThrow();
  });

  it('refuses when an existing user belongs to another tenant', () => {
    expect(() => assertSameTenant('a@b.com', 'tenant-a', 'tenant-b')).toThrow(/Refusing: a@b.com belongs to tenant tenant-a/);
  });

  it('builds an empty patch when the seat already matches', () => {
    const row = {
      tenant_id: 't1',
      company_id: 'c1',
      company_role: 'director',
      status: 'active',
      firm_role: null,
      can_invite: true,
    };
    expect(patchUserSeatDrift(row, { ...row })).toEqual({});
  });

  it('lists seed-sandbox-firm once in the Supabase client fence allowlist', () => {
    const paths = (supabaseClientAllowlist as Array<{ file: string }>)
      .map((e) => e.file)
      .filter((f) => f === 'scripts/sandbox/seed-sandbox-firm.ts');
    expect(paths).toEqual(['scripts/sandbox/seed-sandbox-firm.ts']);
  });
});

describe('seed-sandbox-firm CLI', () => {
  it('errors on bare --fixture', () => {
    expect(() => resolveFixturePath(['node', 'seed-sandbox-firm.ts', '--fixture', '--apply'])).toThrow(
      /--fixture needs a value/,
    );
  });
});
