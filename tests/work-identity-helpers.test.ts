import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decodeAttemptCookie,
  digest,
  encodeAttemptCookie,
  flowCookieOptions,
  isContainedProfile,
  isPendingIsolated,
  isWorkIdentityUser,
  newFlowSecret,
  workIdentityErrorCopy,
} from '@/lib/auth/workIdentity';
import { WORK_IDENTITY_ERROR } from '@/lib/constants/workIdentity';

describe('flow secrets', () => {
  it('mints distinct high-entropy secrets and digests them as sha256 hex', () => {
    const a = newFlowSecret();
    const b = newFlowSecret();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(digest(a)).toBe(createHash('sha256').update(a).digest('hex'));
    expect(digest(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('round-trips the attempt cookie and rejects malformed values', () => {
    const value = encodeAttemptCookie('att-1', 'secret.with.dots');
    expect(decodeAttemptCookie(value)).toEqual({ attemptId: 'att-1', secret: 'secret.with.dots' });
    for (const bad of [undefined, null, '', 'nodot', '.secret', 'att-1.']) {
      expect(decodeAttemptCookie(bad)).toBeNull();
    }
  });

  it('issues httpOnly lax cookies, secure outside development', () => {
    expect(flowCookieOptions(900, { NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 900,
    });
    expect(flowCookieOptions(900, { NODE_ENV: 'development' } as NodeJS.ProcessEnv).secure).toBe(false);
  });
});

describe('identity classification', () => {
  it('reads work identity only from server-owned app_metadata.providers', () => {
    expect(isWorkIdentityUser({ app_metadata: { providers: ['email', 'azure'] } })).toBe(true);
    expect(isWorkIdentityUser({ app_metadata: { providers: ['email'] } })).toBe(false);
    expect(isWorkIdentityUser({ app_metadata: {} })).toBe(false);
  });

  it('isolates only an invited, company-less, self-tenant profile', () => {
    const base = { id: 'u1', status: 'invited', company_id: null, tenant_id: 'u1' };
    expect(isPendingIsolated(base)).toBe(true);
    expect(isPendingIsolated({ ...base, status: 'active' })).toBe(false);
    expect(isPendingIsolated({ ...base, company_id: 'c1' })).toBe(false);
    expect(isPendingIsolated({ ...base, tenant_id: 'firm-tenant' })).toBe(false);
    expect(isPendingIsolated(null)).toBe(false);
  });

  it('recognizes contained provisioning', () => {
    expect(isContainedProfile({ provisioning: 'contained' })).toBe(true);
    expect(isContainedProfile({ provisioning: 'authorized' })).toBe(false);
    expect(isContainedProfile(null)).toBe(false);
  });
});

describe('error copy', () => {
  it('gives every code a plain sentence without em-dashes', () => {
    for (const code of Object.values(WORK_IDENTITY_ERROR)) {
      const { message } = workIdentityErrorCopy(code);
      expect(message, code).toMatch(/\.$/);
      expect(message, code).not.toContain('—');
    }
  });

  it('asks for a resend when the invite context is missing', () => {
    expect(workIdentityErrorCopy('invite_context_missing').message).toBe(
      'This invitation needs to be resent. Ask the sender to resend it.',
    );
  });

  it.each(['nonsense', '__proto__', 'constructor', 'toString'])('reads %s as a provider failure', (code) => {
    expect(workIdentityErrorCopy(code)).toEqual(workIdentityErrorCopy(WORK_IDENTITY_ERROR.PROVIDER_FAILED));
  });
});

describe('ambiguous connect outcome', () => {
  it('maps work_identity_ambiguous to its own code and connect copy', async () => {
    const { errorCodeFrom } = await import('@/app/auth/work/_shared');
    const { workIdentityConnectCopy } = await import('@/lib/auth/workIdentityCopy');
    const code = errorCodeFrom('work_identity_ambiguous');
    expect(code).toBe(WORK_IDENTITY_ERROR.IDENTITY_AMBIGUOUS);
    expect(workIdentityConnectCopy(code)).toMatch(/did not return a single new work account/);
  });
});

describe('invitation from another firm (#408)', () => {
  it('maps invite_other_firm to its own code with an administrator recovery, never connect', async () => {
    const { errorCodeFrom } = await import('@/app/auth/work/_shared');
    const code = errorCodeFrom('invite_other_firm');
    expect(code).toBe(WORK_IDENTITY_ERROR.INVITE_OTHER_FIRM);
    expect(workIdentityErrorCopy(code)).toEqual({
      message: expect.stringMatching(/from another firm/),
      recovery: 'contact_admin',
    });
  });
});
