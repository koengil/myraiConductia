import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveSender } from '../src/lib/email/sender';
import { defaultFromAddress } from '../src/lib/email/transport';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('resolveSender outside dev', () => {
  it('refuses to send from the sandbox sender when RESEND_FROM is unset', () => {
    expect(() =>
      resolveSender('RESEND_FROM', { NEXT_PUBLIC_APP_ENV: 'prod' }),
    ).toThrow(/RESEND_FROM is not set/);
  });

  it('refuses when RESEND_FROM is still the resend.dev sandbox address', () => {
    expect(() =>
      resolveSender('RESEND_FROM', {
        NEXT_PUBLIC_APP_ENV: 'prod',
        RESEND_FROM: 'Conductia <onboarding@resend.dev>',
      }),
    ).toThrow(/sandbox sender/);
  });

  it('names the delivery consequence so the error is actionable', () => {
    expect(() => resolveSender('EMAIL_FROM', { NEXT_PUBLIC_APP_ENV: 'staging' })).toThrow(
      /delivers only to the Resend account owner/,
    );
  });

  it('accepts a verified-domain sender', () => {
    expect(
      resolveSender('RESEND_FROM', {
        NEXT_PUBLIC_APP_ENV: 'prod',
        RESEND_FROM: 'Conductia <info@conductia.com>',
      }),
    ).toBe('Conductia <info@conductia.com>');
  });
});

describe('resolveSender in dev', () => {
  it('keeps the sandbox fallback so local and E2E runs are unaffected', () => {
    expect(resolveSender('RESEND_FROM', { NEXT_PUBLIC_APP_ENV: 'dev' })).toBe(
      'Conductia <onboarding@resend.dev>',
    );
  });

  it('still prefers a configured sender in dev', () => {
    expect(
      resolveSender('RESEND_FROM', {
        NEXT_PUBLIC_APP_ENV: 'dev',
        RESEND_FROM: 'Conductia E2E <invites@e2e.local>',
      }),
    ).toBe('Conductia E2E <invites@e2e.local>');
  });
});

describe('defaultFromAddress', () => {
  it('fails closed on the screened outbox sender outside dev', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'prod');
    vi.stubEnv('EMAIL_FROM', '');
    expect(() => defaultFromAddress()).toThrow(/EMAIL_FROM is not set/);
  });

  it('returns the configured outbox sender', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'prod');
    vi.stubEnv('EMAIL_FROM', 'Conductia <info@conductia.com>');
    expect(defaultFromAddress()).toBe('Conductia <info@conductia.com>');
  });
});
