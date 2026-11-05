import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendInviteEmail, sendInviteVerificationEmail } from '../src/lib/email/resend';
import { INVITE_TTL_HOURS } from '../src/lib/constants/invites';

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'dev');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('invite emails', () => {
  it('names the server-resolved inviter, firm, and deal while keeping the subject generic', async () => {
    vi.stubEnv('RESEND_API_KEY', 'test-key');
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    await sendInviteEmail({
      to: 'recipient@example.com',
      origin: 'https://app.example',
      acceptUrl: 'https://app.example/accept-invite?opaque=1',
      inviterName: 'Alex Rivera',
      companyName: 'A & Co',
      dealCodename: 'Project "North"',
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit | undefined];
    if (!init) throw new Error('Expected email transport request options');
    const payload = JSON.parse(init.body as string) as { subject: string; html: string };
    expect(payload.subject).toBe('You have a Conductia invitation');
    expect(payload.html).toContain('Alex Rivera at A &amp; Co has invited you to Project &quot;North&quot;.');
    expect(payload.html).toContain('https://app.example/accept-invite?opaque=1');
  });

  it('escapes the server-resolved inviter name in the body', async () => {
    vi.stubEnv('RESEND_API_KEY', 'test-key');
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await sendInviteEmail({
      to: 'recipient@example.com',
      origin: 'https://app.example',
      acceptUrl: 'https://app.example/accept-invite?opaque=1',
      inviterName: '<Conductia Security Desk>',
      companyName: 'A & Co',
      dealCodename: null,
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(init.body).toContain('&lt;Conductia Security Desk&gt; at A &amp; Co');
    expect(init.body).not.toContain('<Conductia Security Desk>');
  });

  it('uses neutral copy when the inviter no longer has a company', async () => {
    vi.stubEnv('RESEND_API_KEY', 'test-key');
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await sendInviteEmail({
      to: 'recipient@example.com',
      origin: 'https://app.example',
      acceptUrl: 'https://app.example/accept-invite?opaque=1',
      inviterName: 'A colleague',
      companyName: null,
      dealCodename: null,
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(init.body).toContain('A colleague has invited you to join Conductia.');
    expect(init.body).not.toContain('at Conductia');
  });

  it('sends the verification code in a separate email', async () => {
    vi.stubEnv('RESEND_API_KEY', 'test-key');
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    await sendInviteVerificationEmail({
      to: 'recipient@example.com',
      origin: 'https://app.example', verificationCode: '123456', challengeVersion: 2,
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [
      RequestInfo | URL,
      RequestInit | undefined,
    ];
    const payload = JSON.parse(init?.body as string) as { subject: string; html: string };
    expect(payload.subject).toBe('Your Conductia verification code (2)');
    expect(payload.html).toContain('123456');
  });

  // The Ignatious launch: the link email promised 7 days while the GoTrue
  // token it carried lasted at most 24, and the first director opened it 15
  // hours later. Neither email may state a lifetime longer than
  // INVITE_TTL_HOURS.
  it('states the real invitation lifetime and never the old seven days', async () => {
    vi.stubEnv('RESEND_API_KEY', 'test-key');
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await sendInviteEmail({
      to: 'recipient@example.com',
      origin: 'https://app.example',
      acceptUrl: 'https://app.example/accept-invite?opaque=1',
      inviterName: 'Alex Rivera',
      companyName: 'A & Co',
      dealCodename: null,
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    const payload = JSON.parse(init.body as string) as { html: string };
    expect(payload.html).toContain(`expires within ${INVITE_TTL_HOURS} hours`);
    expect(payload.html).not.toMatch(/7 days|seven days/i);
  });

  // A rotated code is not necessarily numerically larger than the one it
  // replaces, so the version has to be readable in the body. Here the live
  // code (100000) is LOWER than the retired one an invitee might still have.
  it('identifies the code by its version so a lower rotated code is still the right one', async () => {
    vi.stubEnv('RESEND_API_KEY', 'test-key');
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await sendInviteVerificationEmail({
      to: 'recipient@example.com',
      origin: 'https://app.example',
      verificationCode: '100000',
      challengeVersion: 3,
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    const payload = JSON.parse(init.body as string) as { html: string };
    expect(payload.html).toContain('This is code number 3 for your invitation.');
    expect(payload.html).toContain('highest code number');
    expect(payload.html).toContain(`within ${INVITE_TTL_HOURS} hours`);
  });
});

describe('RESEND_API_BASE', () => {
  it('posts to api.resend.com when unset', async () => {
    vi.stubEnv('RESEND_API_BASE', undefined);
    vi.stubEnv('RESEND_API_KEY', 'test-key');
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await sendInviteEmail({
      to: 'someone@example.com',
      origin: 'https://app.example',
      acceptUrl: 'http://127.0.0.1:3000/accept-invite#token',
      inviterName: 'Storm Duncan',
      companyName: 'Futureproofing Capital',
      dealCodename: 'Project Test',
    });

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.resend.com/emails');
  });

  it('posts to RESEND_API_BASE when set, for both send functions', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'dev');
    vi.stubEnv('RESEND_API_BASE', 'http://127.0.0.1:4310');
    vi.stubEnv('RESEND_API_KEY', 'test-key');
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await sendInviteVerificationEmail({
      to: 'someone@example.com',
      origin: 'https://app.example',
      verificationCode: '123456',
      challengeVersion: 1,
    });
    await sendInviteEmail({
      to: 'someone@example.com',
      origin: 'https://app.example',
      acceptUrl: 'http://127.0.0.1:3000/accept-invite#token',
      inviterName: 'Storm Duncan',
      companyName: null,
      dealCodename: null,
    });

    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:4310/emails');
    expect(fetchMock.mock.calls[1][0]).toBe('http://127.0.0.1:4310/emails');
  });
});

describe('RESEND_API_BASE outside dev', () => {
  it('refuses to send rather than posting the link and the challenge to the override', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'production');
    vi.stubEnv('RESEND_FROM', 'Conductia <info@conductia.com>');
    vi.stubEnv('RESEND_API_BASE', 'http://attacker.example');
    vi.stubEnv('RESEND_API_KEY', 'test-key');
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      sendInviteEmail({
        to: 'someone@example.com',
        origin: 'https://app.example',
        acceptUrl: 'https://app.example/accept-invite#token',
        inviterName: 'Storm Duncan',
        companyName: null,
        dealCodename: null,
      }),
    ).rejects.toThrow('RESEND_API_BASE is not allowed outside dev');

    await expect(
      sendInviteVerificationEmail({
        to: 'someone@example.com',
        origin: 'https://app.example',
        verificationCode: '123456',
        challengeVersion: 1,
      }),
    ).rejects.toThrow('RESEND_API_BASE is not allowed outside dev');

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the sender address outside dev', () => {
  it('refuses to send rather than falling back to the resend.dev sandbox sender', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'production');
    vi.stubEnv('RESEND_FROM', '');
    vi.stubEnv('RESEND_API_KEY', 'test-key');
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      sendInviteEmail({
        to: 'someone@example.com',
        origin: 'https://app.example',
        acceptUrl: 'https://app.example/accept-invite#token',
        inviterName: 'Storm Duncan',
        companyName: null,
        dealCodename: null,
      }),
    ).rejects.toThrow(/RESEND_FROM is not set/);

    await expect(
      sendInviteVerificationEmail({
        to: 'someone@example.com',
        origin: 'https://app.example',
        verificationCode: '123456',
        challengeVersion: 1,
      }),
    ).rejects.toThrow(/RESEND_FROM is not set/);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
