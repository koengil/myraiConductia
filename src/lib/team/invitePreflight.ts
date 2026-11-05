import { INVITE_DOMAIN_CONFIRMATION_CLASSIFICATIONS } from '@/lib/constants/invites';

export type ConfirmationClassification =
  (typeof INVITE_DOMAIN_CONFIRMATION_CLASSIFICATIONS)[number];

export type InvitePreflight =
  | { kind: 'clear'; normalizedEmail: string | null }
  | {
      kind: 'confirm';
      normalizedEmail: string | null;
      id: string;
      classification: ConfirmationClassification;
      expiresAt: string;
    }
  | { kind: 'error'; status: number | null; message: string | null };

/**
 * POST /api/v1/invites/preflight and validate the answer (#250). Every invite
 * surface goes through this, so a malformed confirmation can never be read as
 * "no confirmation needed". `message` is the server's error text when it sent
 * one; each caller supplies its own fallback copy.
 */
export async function preflightInvite(body: {
  email: string;
  companyId: string;
  companyRole: string;
  dealId?: string | null;
  dealRole?: string | null;
}): Promise<InvitePreflight> {
  const response = await fetch('/api/v1/invites/preflight', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    return {
      kind: 'error',
      status: response.status,
      message: typeof data.error === 'string' ? data.error : null,
    };
  }
  const normalizedEmail = typeof data.normalizedEmail === 'string' ? data.normalizedEmail : null;
  if (data.confirmationRequired !== true) return { kind: 'clear', normalizedEmail };
  const classification = INVITE_DOMAIN_CONFIRMATION_CLASSIFICATIONS.find(
    (value) => value === data.classification,
  );
  if (
    typeof data.confirmationId !== 'string' ||
    typeof data.expiresAt !== 'string' ||
    !classification
  ) {
    return { kind: 'error', status: null, message: null };
  }
  return {
    kind: 'confirm',
    normalizedEmail,
    id: data.confirmationId,
    classification,
    expiresAt: data.expiresAt,
  };
}
