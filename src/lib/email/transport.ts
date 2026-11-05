/**
 * EmailTransport — the env-selected provider seam for the compliance email
 * client. The screening service decides IF a message may leave; this module
 * only decides HOW it leaves, so providers swap without touching either.
 *
 * Providers (EMAIL_PROVIDER):
 *   resend — the MVP provider (HTTPS API; RESEND_API_KEY; from address must
 *            be on a verified domain). Default when a key is present.
 *   noop   — no provider configured: send() succeeds locally and is marked
 *            simulated, so the full screen -> verdict -> outbox flow is
 *            exercisable in dev without credentials.
 *
 * The real-product path (bankers on M365 must send as their own mailbox) is a
 * future 'graph' transport via Microsoft Graph sendMail with delegated OAuth —
 * add it here; the client and the screening service do not change.
 */

import { OperatorCopyError, UpstreamHttpError, upstreamErrorCode } from '@/lib/errors/upstream';
import { resolveSender } from './sender';

export type EmailAttachment = {
  filename: string;
  /** Raw file bytes, base64-encoded. Forwarded to the provider, never stored. */
  contentBase64: string;
  contentType?: string;
};

export type EmailSendInput = {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  /** The screened plain text — always present, the canonical body. */
  text: string;
  /** Optional rich body rendered by the composer's formatting toolbar. */
  html?: string;
  attachments?: EmailAttachment[];
  /**
   * RFC 5322 threading (#339): the Message-ID this message answers, and the
   * chain it continues (oldest first), each in angle brackets. Validated by
   * the outbox route (MESSAGE_ID_RX, ./messageId); a transport only carries them.
   */
  inReplyTo?: string;
  references?: string[];
};

/**
 * A message with no From (#490). A connected mailbox sends as its own address,
 * so the caller cannot name one; the platform From is added only when the
 * platform transport sends.
 */
export type MessageInput = Omit<EmailSendInput, 'from'>;

export type EmailSendReceipt = {
  /** Provider message id (or a local id for the noop transport). */
  id: string;
  provider: string;
  /** True when no real provider was configured and nothing actually left. */
  simulated?: boolean;
};

export interface EmailTransport {
  readonly provider: string;
  send(input: EmailSendInput): Promise<EmailSendReceipt>;
}

const RESEND_URL = 'https://api.resend.com/emails';

class ResendTransport implements EmailTransport {
  readonly provider = 'resend';

  constructor(private readonly apiKey: string) {}

  async send(input: EmailSendInput): Promise<EmailSendReceipt> {
    const res = await fetch(RESEND_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: input.from,
        to: input.to,
        ...(input.cc?.length ? { cc: input.cc } : {}),
        ...(input.bcc?.length ? { bcc: input.bcc } : {}),
        subject: input.subject,
        text: input.text,
        ...(input.html ? { html: input.html } : {}),
        ...(input.attachments?.length
          ? {
              attachments: input.attachments.map((a) => ({
                filename: a.filename,
                content: a.contentBase64,
                ...(a.contentType ? { content_type: a.contentType } : {}),
              })),
            }
          : {}),
        ...(input.inReplyTo
          ? {
              headers: {
                'In-Reply-To': input.inReplyTo,
                ...(input.references?.length ? { References: input.references.join(' ') } : {}),
              },
            }
          : {}),
      }),
    });
    // A refusal carries the status and Resend's error name, never its message:
    // the message can quote the recipient, the sender domain or the subject.
    if (!res.ok) throw new UpstreamHttpError('resend', 'send', res.status, await upstreamErrorCode(res));
    const data = (await res.json().catch(() => ({}))) as { id?: string };
    return { id: data.id ?? 'unknown', provider: this.provider };
  }
}

class NoopTransport implements EmailTransport {
  readonly provider = 'noop';

  async send(input: EmailSendInput): Promise<EmailSendReceipt> {
    return {
      id: `noop-${Date.now().toString(36)}-${input.to.length}`,
      provider: this.provider,
      simulated: true,
    };
  }
}

/** The platform "from" address; must be on a provider-verified domain. */
export function defaultFromAddress(): string {
  return resolveSender('EMAIL_FROM');
}

export function getEmailTransport(): EmailTransport {
  const provider = process.env.EMAIL_PROVIDER || (process.env.RESEND_API_KEY ? 'resend' : 'noop');

  switch (provider) {
    case 'resend': {
      const apiKey = process.env.RESEND_API_KEY;
      if (!apiKey) throw new OperatorCopyError('EMAIL_PROVIDER=resend requires RESEND_API_KEY');
      return new ResendTransport(apiKey);
    }
    case 'noop':
      return new NoopTransport();
    default:
      throw new Error(`Unknown EMAIL_PROVIDER: ${provider}`);
  }
}
