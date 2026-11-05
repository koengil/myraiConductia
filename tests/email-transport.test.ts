import { afterEach, describe, expect, it, vi } from 'vitest';
import { getEmailTransport } from '../src/lib/email/transport';
import { OperatorCopyError, UpstreamHttpError } from '../src/lib/errors/upstream';

/*
 * EmailTransport — the env-selected provider seam (EMAIL_PROVIDER), so the
 * MVP provider (Resend) can be swapped for Microsoft Graph send-as-user
 * without touching the client or the screening service.
 *
 * Contracts under test:
 *   1. No provider configured -> noop transport; send() succeeds, simulated.
 *   2. EMAIL_PROVIDER=resend without RESEND_API_KEY -> throws loudly.
 *   3. Resend transport POSTs to the Resend API and returns the provider id.
 *   4. Resend API failure -> send() rejects (the caller decides the outcome).
 *   5. Unknown EMAIL_PROVIDER -> throws loudly.
 */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const input = {
  from: 'Conductia <deals@conductia.dev>',
  to: ['founder@target.com'],
  subject: 'Process update',
  text: 'The room opens Monday.',
};

describe('getEmailTransport', () => {
  it('defaults to the noop transport when nothing is configured', async () => {
    vi.stubEnv('EMAIL_PROVIDER', '');
    vi.stubEnv('RESEND_API_KEY', '');
    const transport = getEmailTransport();
    expect(transport.provider).toBe('noop');
    const receipt = await transport.send(input);
    expect(receipt.simulated).toBe(true);
    expect(receipt.id).toBeTruthy();
  });

  it('selects resend when RESEND_API_KEY is present and EMAIL_PROVIDER is unset', () => {
    vi.stubEnv('EMAIL_PROVIDER', '');
    vi.stubEnv('RESEND_API_KEY', 'test-key');
    expect(getEmailTransport().provider).toBe('resend');
  });

  it('throws when EMAIL_PROVIDER=resend but the key is missing', () => {
    vi.stubEnv('EMAIL_PROVIDER', 'resend');
    vi.stubEnv('RESEND_API_KEY', '');
    expect(() => getEmailTransport()).toThrow(/RESEND_API_KEY/);
  });

  it('throws on an unknown provider', () => {
    vi.stubEnv('EMAIL_PROVIDER', 'pigeon');
    expect(() => getEmailTransport()).toThrow(/EMAIL_PROVIDER/);
  });
});

describe('resend transport', () => {
  it('POSTs to the Resend API and returns the provider message id', async () => {
    vi.stubEnv('EMAIL_PROVIDER', 'resend');
    vi.stubEnv('RESEND_API_KEY', 'test-key');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 'resend-msg-1' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const receipt = await getEmailTransport().send(input);
    expect(receipt).toMatchObject({ id: 'resend-msg-1', provider: 'resend' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
    expect(JSON.parse(init.body as string)).toMatchObject({
      from: input.from,
      to: input.to,
      subject: input.subject,
      text: input.text,
    });
  });

  it('forwards cc/bcc, html and attachments to the Resend payload', async () => {
    vi.stubEnv('EMAIL_PROVIDER', 'resend');
    vi.stubEnv('RESEND_API_KEY', 'test-key');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 'resend-msg-2' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await getEmailTransport().send({
      ...input,
      cc: ['counsel@bank.dev'],
      bcc: ['records@bank.dev'],
      html: '<p>The room opens <strong>Monday</strong>.</p>',
      attachments: [{ filename: 'teaser.pdf', contentBase64: 'aGVsbG8=', contentType: 'application/pdf' }],
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(init.body as string);
    expect(payload.cc).toEqual(['counsel@bank.dev']);
    expect(payload.bcc).toEqual(['records@bank.dev']);
    expect(payload.html).toContain('<strong>Monday</strong>');
    expect(payload.attachments).toEqual([
      { filename: 'teaser.pdf', content: 'aGVsbG8=', content_type: 'application/pdf' },
    ]);
  });

  it('threads a reply through Resend headers, and sends none for a new message (#339)', async () => {
    vi.stubEnv('EMAIL_PROVIDER', 'resend');
    vi.stubEnv('RESEND_API_KEY', 'test-key');
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ id: 'resend-msg-3' }) });
    vi.stubGlobal('fetch', fetchMock);

    await getEmailTransport().send({ ...input, inReplyTo: '<b@x.example>', references: ['<a@x.example>', '<b@x.example>'] });
    await getEmailTransport().send(input);

    const payloads = fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string));
    expect(payloads[0].headers).toEqual({ 'In-Reply-To': '<b@x.example>', References: '<a@x.example> <b@x.example>' });
    expect(payloads[1]).not.toHaveProperty('headers');
  });

  it('rejects when the Resend API errors', async () => {
    vi.stubEnv('EMAIL_PROVIDER', 'resend');
    vi.stubEnv('RESEND_API_KEY', 'test-key');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        json: () => Promise.resolve({ name: 'validation_error', message: 'domain not verified' }),
      }),
    );
    const failure = await getEmailTransport().send(input).catch((e: unknown) => e);
    // The status and Resend's error name, never its sentence.
    expect(failure).toBeInstanceOf(UpstreamHttpError);
    expect(failure).toMatchObject({ provider: 'resend', op: 'send', status: 422, code: 'validation_error' });
    expect((failure as Error).message).toBe('resend send failed: 422 validation_error');
    expect((failure as Error).message).not.toMatch(/domain not verified/);
  });

  it('a missing Resend key is operator copy, worded as before', () => {
    vi.stubEnv('EMAIL_PROVIDER', 'resend');
    vi.stubEnv('RESEND_API_KEY', '');
    let thrown: unknown;
    try {
      getEmailTransport();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(OperatorCopyError);
    expect((thrown as Error).message).toBe('EMAIL_PROVIDER=resend requires RESEND_API_KEY');
  });
});
