// Invite email delivery via Resend's REST API (raw fetch — one endpoint, no
// SDK). Supabase generates the accept link (auth mechanics stay Supabase's);
// Resend carries the branded email because Supabase's built-in SMTP is
// rate-limited and spam-prone — unusable for a live demo.
//
// Both bodies are composed from the shared Workbench register
// (./workbenchEmail). `origin` is required on both param types rather than
// optional: it resolves the brand mark's URL, and an optional origin would mean
// a silent no-mark branch, which is how the invitation drifted off-brand before.
//
// RESEND_FROM must be a sender on a verified Resend domain for delivery to
// arbitrary recipients; the resend.dev sandbox default only delivers to the
// Resend account owner's own inbox.

import { INVITE_TTL_HOURS } from '@/lib/constants/invites';
import { OperatorCopyError, UpstreamHttpError, upstreamErrorCode } from '@/lib/errors/upstream';
import { resolveSender } from './sender';
import { codeRow, ctaRow, emailShell, textRow } from './workbenchEmail';

export interface InviteEmailParams {
  to: string;
  acceptUrl: string;
  /** The application's own origin, used to resolve the brand mark. Required. */
  origin: string;
  inviterName: string;
  companyName: string | null;
  dealCodename: string | null;
  /** Stable across retries so a network retry cannot create a duplicate email. */
  idempotencyKey?: string;
}

export interface InviteVerificationEmailParams {
  to: string;
  verificationCode: string;
  /** The application's own origin, used to resolve the brand mark. Required. */
  origin: string;
  challengeVersion: number;
  /** Stable across retries so a network retry cannot create a duplicate email. */
  idempotencyKey?: string;
}

// A refused send carries the status and Resend's error name, never its body:
// the body can quote the recipient, the sender domain or the message.
async function resendFailure(op: string, res: Response): Promise<UpstreamHttpError> {
  return new UpstreamHttpError('resend', op, res.status, await upstreamErrorCode(res));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  })[character] as string);
}

function sender(): string {
  return resolveSender('RESEND_FROM');
}

/**
 * Resend's REST origin. Overridable so the hermetic E2E tier can point the
 * send path at an in-suite stub (design D7): invite mail is real Resend called
 * server-side, there is no outbox row for it, and Supabase's Inbucket never
 * sees it — so a browser cannot intercept it without a seam here.
 *
 * Fail-closed outside dev rather than documented as "production never sets
 * this": the override redirects both the action link and the 6-digit challenge
 * to whatever origin it names, so a mis-set value in a deployed environment is
 * a credential leak. `NEXT_PUBLIC_APP_ENV` is the same dev signal
 * `isMfaBypassEnabled` gates on.
 */
function resendBaseUrl(): string {
  const override = process.env.RESEND_API_BASE;
  if (!override) return 'https://api.resend.com';
  if (process.env.NEXT_PUBLIC_APP_ENV !== 'dev') {
    throw new Error('RESEND_API_BASE is not allowed outside dev');
  }
  return override.replace(/\/+$/, '');
}

export async function sendInviteEmail(params: InviteEmailParams): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new OperatorCopyError('RESEND_API_KEY is not set');
  }
  const from = sender();
  const inviterName = escapeHtml(params.inviterName);
  const companyName = params.companyName ? escapeHtml(params.companyName) : null;
  const dealName = params.dealCodename ? escapeHtml(params.dealCodename) : null;
  const inviter = companyName ? `${inviterName} at ${companyName}` : inviterName;
  const invitation = dealName
    ? `${inviter} has invited you to ${dealName}.`
    : `${inviter} has invited you to join Conductia.`;

  const html = emailShell({
    origin: params.origin,
    eyebrow: 'Account action',
    headline: 'You have an invitation waiting.',
    // The register's one serif moment: the invitation itself is the letterhead.
    headlineFace: 'serif',
    rows: [
      textRow(
        `${invitation} Use the secure link below to continue. The link is intended only for this email address.`,
      ),
      ctaRow(params.acceptUrl, 'Continue securely'),
    ],
    footer: `This invitation expires within ${INVITE_TTL_HOURS} hours, so please open it today. It is personal to this address. Every action on Conductia is recorded in the deal audit log. If you were not expecting this, you can ignore this email.`,
  });

  const res = await fetch(`${resendBaseUrl()}/emails`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(params.idempotencyKey ? { 'Idempotency-Key': params.idempotencyKey } : {}),
    },
    body: JSON.stringify({
      from,
      to: [params.to],
      // Keep the verified-domain subject generic. The inviter name is resolved
      // from the authenticated server-side account and appears only in the body.
      subject: 'You have a Conductia invitation',
      html,
    }),
  });

  if (!res.ok) throw await resendFailure('send', res);
}

/** Kept separate from the action link so the invitee, never the inviter, receives the code. */
export async function sendInviteVerificationEmail(
  params: InviteVerificationEmailParams,
): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new OperatorCopyError('RESEND_API_KEY is not set');

  const res = await fetch(`${resendBaseUrl()}/emails`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(params.idempotencyKey ? { 'Idempotency-Key': params.idempotencyKey } : {}),
    },
    body: JSON.stringify({
      from: sender(),
      to: [params.to],
      subject: `Your Conductia verification code (${params.challengeVersion})`,
      // The version belongs in the BODY, not only the subject. Read on its
      // own, "use the highest-numbered code" points at the six digits, and a
      // rotated code that happens to be numerically lower sends the invitee
      // confidently back to the dead one, burning attempts against
      // INVITE_CHALLENGE_MAX_ATTEMPTS and eventually locking the challenge.
      html: emailShell({
        origin: params.origin,
        eyebrow: 'Verification',
        headline: 'Your verification code',
        rows: [
          // The bare <strong> is the hermetic parser's contract; its parent
          // carries the colour pair (see codeRow).
          codeRow(
            `Your Conductia verification code is <strong>${escapeHtml(params.verificationCode)}</strong>.`,
          ),
          textRow(
            `This is code number ${params.challengeVersion} for your invitation. If you have received more than one of these emails, use the one with the highest code number. Each resend replaces the previous code.`,
          ),
        ],
        footer: `This code expires with your invitation, within ${INVITE_TTL_HOURS} hours. Do not share it with anyone.`,
      }),
    }),
  });
  if (!res.ok) throw await resendFailure('verification send', res);
}
