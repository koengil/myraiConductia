import { afterEach, describe, expect, it, vi } from 'vitest';

import { isMfaBypassEnabled } from '@/lib/auth/mfaBypass';

describe('isMfaBypassEnabled', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is off outside dev', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'staging');
    vi.stubEnv('DISABLE_MFA', 'true');
    expect(isMfaBypassEnabled()).toBe(false);
  });

  it('is off in dev unless DISABLE_MFA or NEXT_PUBLIC_DISABLE_MFA is set', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'dev');
    expect(isMfaBypassEnabled()).toBe(false);
    vi.stubEnv('DISABLE_MFA', 'true');
    expect(isMfaBypassEnabled()).toBe(true);
    vi.unstubAllEnvs();
    vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'dev');
    vi.stubEnv('NEXT_PUBLIC_DISABLE_MFA', 'true');
    expect(isMfaBypassEnabled()).toBe(true);
  });
});
