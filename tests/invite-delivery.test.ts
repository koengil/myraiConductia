/**
 * deliverInvite integration coverage (cr-prr-124 1.3 + 2.1): the real helper
 * against a mocked admin client — no deliverInvite mock, so the provider
 * interaction (invite link vs existing-identity magiclink, containment
 * proof, nonce rotation) is exercised for real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { deliverInvite, fetchInviteEmailContext } from '@/lib/api/v1/inviteDelivery';

vi.mock('@/lib/email/resend', () => ({ sendInviteEmail: vi.fn(), sendInviteVerificationEmail: vi.fn() }));
import { sendInviteEmail, sendInviteVerificationEmail } from '@/lib/email/resend';
import { UpstreamHttpError } from '@/lib/errors/upstream';
import { captureConsole, type ConsoleCapture } from './helpers/consoleCapture';

const INVITE = {
  id: 'inv-1',
  email: 'director@vista.com',
  credentialNonce: 'nonce-rotated',
  tenantId: 'tenant-1',
  isExternal: true,
  verificationCode: '123456',
  challengeVersion: 1,
  inviterName: 'Storm Duncan',
  inviterCompanyName: 'Futureproofing Capital',
  dealCodename: 'Project Rangers',
  authMethod: 'email_code' as const,
  workIdentityEnabled: false,
};

type LinkResult = {
  data: { properties: { action_link: string } | null; user: { id: string } | null } | null;
  error: { code?: string; message?: string } | null;
};

function makeAdmin(opts: {
  inviteLink?: LinkResult;
  magicLink?: LinkResult;
  containRows?: Array<{ id: string }> | null;
  containError?: { message: string } | null;
  mirror?: {
    id: string;
    status: string;
    company_id: string | null;
    tenant_id?: string;
    provisioning?: string;
  } | null;
  metadataError?: { message: string } | null;
}) {
  const generateLink = vi.fn(async ({ type }: { type: string }) => {
    if (type === 'invite') {
      return (
        opts.inviteLink ?? {
          data: { properties: { action_link: 'https://sb/invite-link' }, user: { id: 'auth-1' } },
          error: null,
        }
      );
    }
    return (
      opts.magicLink ?? {
        data: { properties: { action_link: 'https://sb/magic-link' }, user: { id: 'auth-1' } },
        error: null,
      }
    );
  });
  const updateUserById = vi.fn<(id: string, attributes: Record<string, unknown>) => Promise<unknown>>(
    async () => ({ data: {}, error: opts.metadataError ?? null }),
  );
  const update = vi.fn();
  // Self-chaining update builder: both the fresh-identity containment update
  // (.eq.is.select) and the repair update (.eq.eq.is.select) resolve here.
  const updateBuilder = {
    eq: vi.fn(() => updateBuilder),
    is: vi.fn(() => updateBuilder),
    select: vi.fn(async () => ({
      data: 'containRows' in opts ? opts.containRows : [{ id: 'auth-1' }],
      error: opts.containError ?? null,
    })),
  };
  const admin = {
    auth: { admin: { generateLink, updateUserById } },
    rpc: vi.fn(async () => ({ data: true, error: null })),
    from: vi.fn(() => ({
      update: update.mockImplementation(() => updateBuilder),
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: opts.mirror ?? null, error: null }),
        }),
      }),
    })),
  };
  return {
    admin: admin as never,
    rpc: admin.rpc,
    generateLink,
    updateUserById,
    update,
    updateBuilder,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('deliverInvite — fresh identity', () => {
  it('writes the rotated credential onto an identity generateLink did not create', async () => {
    // GoTrue applies generateLink's `data` only when it creates the identity
    // and ignores it for an existing one, so a resend that still gets an
    // invite-type link back must carry the rotated nonce itself.
    const { admin, updateUserById } = makeAdmin({});
    await deliverInvite(admin, 'https://app.dev', { ...INVITE, credentialNonce: 'nonce-2' });
    expect(updateUserById.mock.calls[0][1]).toMatchObject({
      user_metadata: { invite_id: 'inv-1', credential_nonce: 'nonce-2' },
    });
  });

  it('proves containment then sends the invite link', async () => {
    const { admin, generateLink, updateUserById } = makeAdmin({});
    const result = await deliverInvite(admin, 'https://app.dev', INVITE);
    expect(result.deliveryStatus).toBe('sent');
    expect(generateLink).toHaveBeenCalledTimes(1);
    expect(updateUserById).toHaveBeenCalledWith('auth-1', {
      user_metadata: {
        invite_id: 'inv-1',
        credential_nonce: 'nonce-rotated',
        is_external: true,
        tenant_id: 'tenant-1',
      },
      app_metadata: { account_origin: 'email_invite' },
    });
    expect(vi.mocked(sendInviteEmail).mock.calls[0][0]).toEqual({
      to: 'director@vista.com',
      // The origin deliverInvite was called with: the brand mark in the email
      // is served from the application's own origin, so it has to reach here.
      origin: 'https://app.dev',
      acceptUrl: 'https://sb/invite-link',
      inviterName: 'Storm Duncan',
      companyName: 'Futureproofing Capital',
      dealCodename: 'Project Rangers',
      idempotencyKey: 'invite-inv-1-challenge-1-link',
    });
    expect(sendInviteVerificationEmail).toHaveBeenCalledWith({
      to: 'director@vista.com',
      origin: 'https://app.dev',
      verificationCode: '123456',
      challengeVersion: 1,
      idempotencyKey: 'invite-inv-1-challenge-1-code',
    });
    expect(
      vi.mocked(sendInviteVerificationEmail).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(sendInviteEmail).mock.invocationCallOrder[0]);
  });

  it('does not send an actionable link when verification-code delivery fails', async () => {
    vi.mocked(sendInviteVerificationEmail).mockRejectedValueOnce(
      new UpstreamHttpError('resend', 'send', 403, 'validation_error'),
    );
    const { admin, rpc } = makeAdmin({});

    const result = await deliverInvite(admin, 'https://app.dev', INVITE);

    // A code, never the provider's sentence.
    expect(result).toEqual({ deliveryStatus: 'unsent', error: 'resend_403' });
    expect(sendInviteEmail).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('retries transient provider failures with stable idempotency keys', async () => {
    const throttled = Object.assign(new Error('rate limited'), { status: 429 });
    const unavailable = Object.assign(new Error('service unavailable'), { status: 503 });
    vi.mocked(sendInviteVerificationEmail)
      .mockRejectedValueOnce(throttled)
      .mockResolvedValueOnce(undefined);
    vi.mocked(sendInviteEmail)
      .mockRejectedValueOnce(unavailable)
      .mockResolvedValueOnce(undefined);
    const { admin } = makeAdmin({});

    const result = await deliverInvite(admin, 'https://app.dev', INVITE);

    expect(result.deliveryStatus).toBe('sent');
    expect(sendInviteVerificationEmail).toHaveBeenCalledTimes(2);
    expect(sendInviteEmail).toHaveBeenCalledTimes(2);
    expect(vi.mocked(sendInviteVerificationEmail).mock.calls.map(([params]) => params.idempotencyKey)).toEqual([
      'invite-inv-1-challenge-1-code',
      'invite-inv-1-challenge-1-code',
    ]);
    expect(vi.mocked(sendInviteEmail).mock.calls.map(([params]) => params.idempotencyKey)).toEqual([
      'invite-inv-1-challenge-1-link',
      'invite-inv-1-challenge-1-link',
    ]);
    expect(vi.mocked(sendInviteVerificationEmail).mock.invocationCallOrder[1]).toBeLessThan(
      vi.mocked(sendInviteEmail).mock.invocationCallOrder[0],
    );
  });

  it('aborts before email when the server-owned MFA marker cannot be written', async () => {
    const { admin } = makeAdmin({
      metadataError: { message: 'auth unavailable' },
    });
    const result = await deliverInvite(admin, 'https://app.dev', INVITE);
    expect(result).toEqual({
      deliveryStatus: 'unsent',
      error: 'mfa_policy_marker_failed',
    });
    expect(sendInviteEmail).not.toHaveBeenCalled();
  });

  it('aborts before email when the containment update affects no row', async () => {
    const { admin } = makeAdmin({ containRows: [] });
    const result = await deliverInvite(admin, 'https://app.dev', INVITE);
    expect(result).toEqual({ deliveryStatus: 'unsent', error: 'containment_failed' });
    expect(sendInviteEmail).not.toHaveBeenCalled();
  });

  it('aborts before email when the containment update errors', async () => {
    const { admin } = makeAdmin({ containError: { message: 'db down' } });
    const result = await deliverInvite(admin, 'https://app.dev', INVITE);
    expect(result.error).toBe('containment_failed');
    expect(sendInviteEmail).not.toHaveBeenCalled();
  });

  it('aborts when the link response carries no auth user id', async () => {
    const { admin } = makeAdmin({
      inviteLink: {
        data: { properties: { action_link: 'https://sb/invite-link' }, user: null },
        error: null,
      },
    });
    const result = await deliverInvite(admin, 'https://app.dev', INVITE);
    expect(result.error).toBe('containment_failed_no_auth_user');
    expect(sendInviteEmail).not.toHaveBeenCalled();
  });
});

describe('fetchInviteEmailContext', () => {
  it('keeps resend recoverable when the original inviter has been offboarded', async () => {
    const admin = {
      from: vi.fn((table: string) => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => {
              if (table === 'users') return { data: null, error: null };
              if (table === 'companies') return { data: { name: 'Vista', type: 'target' }, error: null };
              return { data: null, error: null };
            },
          }),
        }),
      })),
    } as never;

    await expect(fetchInviteEmailContext(admin, 'offboarded-user', 'company-1', null)).resolves.toMatchObject({
      inviterCompanyName: null,
      companyName: 'Vista',
    });
  });

  it('fails closed for a real context-query error', async () => {
    const admin = {
      from: vi.fn((table: string) => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => (
              table === 'users'
                ? { data: null, error: { message: 'connection lost' } }
                : { data: { name: 'Vista', type: 'target' }, error: null }
            ),
          }),
        }),
      })),
    } as never;

    await expect(fetchInviteEmailContext(admin, 'actor-1', 'company-1', null)).rejects.toThrow(
      'email_context_failed',
    );
  });
});

describe('deliverInvite — existing invited identity (resend)', () => {
  const emailExists: LinkResult = {
    data: null,
    error: { code: 'email_exists', message: 'A user with this email address has already been registered' },
  };

  it('rotates metadata nonce and sends a magiclink instead', async () => {
    const { admin, generateLink, updateUserById } = makeAdmin({
      inviteLink: emailExists,
      mirror: { id: 'auth-1', status: 'invited', company_id: null, tenant_id: 'tenant-1' },
    });
    const result = await deliverInvite(admin, 'https://app.dev', INVITE);
    expect(result.deliveryStatus).toBe('sent');
    expect(updateUserById).toHaveBeenCalledWith('auth-1', {
      user_metadata: expect.objectContaining({
        invite_id: 'inv-1',
        credential_nonce: 'nonce-rotated',
      }),
      app_metadata: { account_origin: 'email_invite' },
    });
    expect(generateLink).toHaveBeenCalledTimes(2);
    expect(generateLink.mock.calls[1][0].type).toBe('magiclink');
    expect(vi.mocked(sendInviteEmail).mock.calls[0][0].acceptUrl).toBe('https://sb/magic-link');
  });

  it('never issues a credential to a provisioned account', async () => {
    const { admin } = makeAdmin({
      inviteLink: emailExists,
      mirror: { id: 'auth-1', status: 'active', company_id: 'comp-9', tenant_id: 'tenant-1' },
    });
    const result = await deliverInvite(admin, 'https://app.dev', INVITE);
    expect(result).toEqual({ deliveryStatus: 'unsent', error: 'active_account_no_credential' });
    expect(sendInviteEmail).not.toHaveBeenCalled();
  });

  it('never issues a credential to a suspended account', async () => {
    const { admin } = makeAdmin({
      inviteLink: emailExists,
      mirror: { id: 'auth-1', status: 'suspended', company_id: null, tenant_id: 'tenant-1' },
    });
    const result = await deliverInvite(admin, 'https://app.dev', INVITE);
    expect(result).toEqual({ deliveryStatus: 'unsent', error: 'active_account_no_credential' });
    expect(sendInviteEmail).not.toHaveBeenCalled();
  });

  it('repairs a failed containment on resend, then delivers (cr-prr-124-r2 2.1)', async () => {
    // A prior attempt created the identity (trigger mirrored it 'active')
    // but the invited flip failed. Resend proves ownership — same email,
    // unprovisioned — re-asserts containment, then rotates and delivers.
    const { admin, generateLink, update, updateBuilder } = makeAdmin({
      inviteLink: emailExists,
      mirror: { id: 'auth-1', status: 'active', company_id: null, tenant_id: 'tenant-1' },
      containRows: [{ id: 'auth-1' }],
    });
    const result = await deliverInvite(admin, 'https://app.dev', INVITE);
    expect(result.deliveryStatus).toBe('sent');
    expect(update).toHaveBeenCalledWith({ status: 'invited' });
    // Tenant equality is enforced INSIDE the conditional repair write, not
    // just the pre-check — no check-to-update race (cr-prr-124-r4 2.1).
    expect(updateBuilder.eq).toHaveBeenCalledWith('tenant_id', 'tenant-1');
    expect(generateLink.mock.calls[1][0].type).toBe('magiclink');
    expect(vi.mocked(sendInviteEmail).mock.calls[0][0].acceptUrl).toBe('https://sb/magic-link');
  });

  it('aborts the repair without a credential when the re-containment affects no row', async () => {
    const { admin } = makeAdmin({
      inviteLink: emailExists,
      mirror: { id: 'auth-1', status: 'active', company_id: null, tenant_id: 'tenant-1' },
      containRows: [],
    });
    const result = await deliverInvite(admin, 'https://app.dev', INVITE);
    expect(result).toEqual({ deliveryStatus: 'unsent', error: 'containment_failed' });
    expect(sendInviteEmail).not.toHaveBeenCalled();
  });

  it('aborts when the metadata rotation fails', async () => {
    const { admin } = makeAdmin({
      inviteLink: emailExists,
      mirror: { id: 'auth-1', status: 'invited', company_id: null, tenant_id: 'tenant-1' },
      metadataError: { message: 'nope' },
    });
    const result = await deliverInvite(admin, 'https://app.dev', INVITE);
    expect(result.error).toBe('credential_rotation_failed');
    expect(sendInviteEmail).not.toHaveBeenCalled();
  });

  it('aborts when no mirror row exists for the email', async () => {
    const { admin } = makeAdmin({ inviteLink: emailExists, mirror: null });
    const result = await deliverInvite(admin, 'https://app.dev', INVITE);
    expect(result.error).toBe('containment_failed_no_mirror');
    expect(sendInviteEmail).not.toHaveBeenCalled();
  });
});

describe('deliverInvite — tenant wall (cr-prr-124-r3 2.1)', () => {
  it('never issues a credential to a cross-tenant mirror, even an unprovisioned one', async () => {
    const { admin } = makeAdmin({
      inviteLink: {
        data: null,
        error: { code: 'email_exists', message: 'already been registered' },
      },
      mirror: { id: 'auth-1', status: 'active', company_id: null, tenant_id: 'tenant-OTHER' },
      containRows: [{ id: 'auth-1' }],
    });
    const result = await deliverInvite(admin, 'https://app.dev', INVITE);
    expect(result).toEqual({ deliveryStatus: 'unsent', error: 'tenant_mismatch_no_credential' });
    expect(sendInviteEmail).not.toHaveBeenCalled();
  });
});

describe('deliverInvite — contained profiles (#316)', () => {
  it('treats a contained self-tenant profile as tenant-compatible and never promotes it', async () => {
    const { admin, generateLink, update } = makeAdmin({
      inviteLink: {
        data: null,
        error: { code: 'email_exists', message: 'already been registered' },
      },
      mirror: {
        id: 'auth-1',
        status: 'invited',
        company_id: null,
        tenant_id: 'auth-1',
        provisioning: 'contained',
      },
    });
    const result = await deliverInvite(admin, 'https://app.dev', INVITE);
    expect(result.deliveryStatus).toBe('sent');
    expect(generateLink).toHaveBeenCalledWith(expect.objectContaining({ type: 'magiclink' }));
    // Already invited: no status write at all, and never a flip to active.
    expect(update).not.toHaveBeenCalled();
  });

  it('never writes an active status on the fresh-identity path', async () => {
    const { admin, update } = makeAdmin({});
    await deliverInvite(admin, 'https://app.dev', INVITE);
    for (const [patch] of update.mock.calls) expect(patch).not.toMatchObject({ status: 'active' });
  });
});

describe('deliverInvite — work identity (#316)', () => {
  const WORK = { ...INVITE, authMethod: 'work_identity' as const, workIdentityEnabled: true };

  it('sends exactly one join link and no code, then finalizes', async () => {
    const { admin, generateLink, updateUserById, rpc } = makeAdmin({});
    const result = await deliverInvite(admin, 'https://app.dev', WORK);
    expect(result).toEqual({ deliveryStatus: 'sent' });
    expect(generateLink).not.toHaveBeenCalled();
    expect(updateUserById).not.toHaveBeenCalled();
    expect(sendInviteVerificationEmail).not.toHaveBeenCalled();
    expect(sendInviteEmail).toHaveBeenCalledTimes(1);
    const [params] = vi.mocked(sendInviteEmail).mock.calls[0];
    expect(params.acceptUrl).toBe('https://app.dev/join?invite=inv-1&k=nonce-rotated');
    expect(params.to).toBe('director@vista.com');
    expect(rpc).toHaveBeenCalledWith('finalize_invite_delivery', { p_invite_id: 'inv-1' });
  });

  it('refuses to deliver a stored work-identity invite while the flag is off', async () => {
    const { admin, generateLink, rpc } = makeAdmin({});
    const result = await deliverInvite(admin, 'https://app.dev', {
      ...WORK,
      workIdentityEnabled: false,
    });
    expect(result).toEqual({ deliveryStatus: 'unsent', error: 'work_identity_disabled' });
    expect(sendInviteEmail).not.toHaveBeenCalled();
    expect(generateLink).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('keeps a legacy email-code invite on the code path even with the flag on', async () => {
    const { admin, generateLink } = makeAdmin({});
    await deliverInvite(admin, 'https://app.dev', { ...INVITE, workIdentityEnabled: true });
    expect(generateLink).toHaveBeenCalledWith(expect.objectContaining({ type: 'invite' }));
    expect(sendInviteVerificationEmail).toHaveBeenCalledTimes(1);
  });
});

describe('invite delivery failure paths keep provider text out of the console (#331)', () => {
  const CANARY = 'CANARY-331 Resend quoted director@vista.com and Project Falcon';
  let capture: ConsoleCapture | undefined;

  afterEach(() => {
    capture?.restore();
    capture = undefined;
  });

  it('logs a code, not the provider message, when the email send fails', async () => {
    vi.mocked(sendInviteVerificationEmail).mockRejectedValueOnce(
      Object.assign(new Error(CANARY), { status: 422, body: { message: CANARY } }),
    );
    capture = captureConsole();

    const result = await deliverInvite(makeAdmin({}).admin, 'https://app.dev', INVITE);

    expect(result).toEqual({ deliveryStatus: 'unsent', error: 'unexpected' });
    expect(capture.output()).toContain('invite delivery failed');
    expect(capture.output()).not.toContain('CANARY-331');
  });

  it('drops a provider code that is a sentence before it is logged', async () => {
    vi.mocked(sendInviteEmail).mockRejectedValueOnce(new UpstreamHttpError('resend', 'send', 403, CANARY, CANARY));
    capture = captureConsole();

    const result = await deliverInvite(makeAdmin({}).admin, 'https://app.dev', INVITE);

    expect(result).toEqual({ deliveryStatus: 'unsent', error: 'resend_403' });
    expect(capture.output()).not.toContain('CANARY-331');
  });

  it('logs a code, not the auth service message, when link generation fails', async () => {
    const { admin } = makeAdmin({ inviteLink: { data: null, error: { message: CANARY } } });
    capture = captureConsole();

    const result = await deliverInvite(admin, 'https://app.dev', INVITE);

    expect(result).toEqual({ deliveryStatus: 'unsent', error: 'link_generation_failed' });
    expect(capture.output()).not.toContain('CANARY-331');
  });

  it('logs the database code, not its message, when the email context lookup fails', async () => {
    const admin = {
      from: vi.fn((table: string) => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () =>
              table === 'users'
                ? { data: null, error: { code: '08006', message: CANARY, details: CANARY } }
                : { data: { name: 'Vista', type: 'target' }, error: null },
          }),
        }),
      })),
    } as never;
    capture = captureConsole();

    await expect(fetchInviteEmailContext(admin, 'actor-1', 'company-1', null)).rejects.toThrow('email_context_failed');
    expect(capture.output()).toContain('08006');
    expect(capture.output()).not.toContain('CANARY-331');
  });
});
