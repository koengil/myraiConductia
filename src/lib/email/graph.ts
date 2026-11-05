import type { SupabaseClient } from '@supabase/supabase-js';
import { OperatorCopyError, UpstreamHttpError, upstreamErrorCode } from '@/lib/errors/upstream';
import { decryptTokens, encryptTokens } from './tokenCrypto';
import type { EmailSendReceipt, MessageInput } from './transport';

/**
 * Microsoft Graph mailbox connection — the real-product path: the banker
 * connects their Microsoft 365 mailbox with OAuth (delegated consent, we
 * never see the password) and the platform sends AS their real address via
 * Graph sendMail. Basic SMTP AUTH is deprecated by Microsoft; Graph is the
 * supported road.
 *
 * Configuration (all server-side env):
 *   MS_CLIENT_ID / MS_CLIENT_SECRET — the Azure app registration.
 *   MS_TENANT                       — directory; defaults to 'common'.
 *   MS_REDIRECT_URI                 — must match the app registration.
 *   MAILBOX_TOKEN_KEY               — 32-byte key (base64 or hex) for
 *                                     AES-256-GCM at-rest token encryption.
 *
 * Unconfigured -> graphConfigured() is false and every surface degrades
 * honestly (the settings screen says so; sends fall back to the default
 * transport, decided in ./connectedSender). Tokens are stored ONLY encrypted
 * (mailbox_connections), through ./tokenCrypto.
 */

const AUTH_BASE = 'https://login.microsoftonline.com';
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
export const GRAPH_SCOPES = 'offline_access User.Read Mail.Send';

export type GraphTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};

export function graphConfigured(): boolean {
  return Boolean(
    process.env.MS_CLIENT_ID &&
      process.env.MS_CLIENT_SECRET &&
      process.env.MS_REDIRECT_URI &&
      process.env.MAILBOX_TOKEN_KEY,
  );
}

function tenant(): string {
  return process.env.MS_TENANT || 'common';
}

export function graphAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: process.env.MS_CLIENT_ID ?? '',
    response_type: 'code',
    redirect_uri: process.env.MS_REDIRECT_URI ?? '',
    response_mode: 'query',
    scope: GRAPH_SCOPES,
    state,
  });
  return `${AUTH_BASE}/${tenant()}/oauth2/v2.0/authorize?${params.toString()}`;
}

async function tokenRequest(body: URLSearchParams): Promise<GraphTokens | null> {
  try {
    const res = await fetch(`${AUTH_BASE}/${tenant()}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!data.access_token || !data.refresh_token) return null;
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    };
  } catch {
    return null;
  }
}

export function exchangeGraphCode(code: string): Promise<GraphTokens | null> {
  return tokenRequest(
    new URLSearchParams({
      client_id: process.env.MS_CLIENT_ID ?? '',
      client_secret: process.env.MS_CLIENT_SECRET ?? '',
      grant_type: 'authorization_code',
      code,
      redirect_uri: process.env.MS_REDIRECT_URI ?? '',
      scope: GRAPH_SCOPES,
    }),
  );
}

export function refreshGraphTokens(refreshToken: string): Promise<GraphTokens | null> {
  return tokenRequest(
    new URLSearchParams({
      client_id: process.env.MS_CLIENT_ID ?? '',
      client_secret: process.env.MS_CLIENT_SECRET ?? '',
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: GRAPH_SCOPES,
    }),
  );
}

/** The connected mailbox identity ({ email, name }) or null. */
export async function graphProfile(
  accessToken: string,
): Promise<{ email: string; name: string | null } | null> {
  try {
    const res = await fetch(`${GRAPH_BASE}/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      mail?: string;
      userPrincipalName?: string;
      displayName?: string;
    };
    const email = data.mail || data.userPrincipalName;
    if (!email) return null;
    return { email, name: data.displayName ?? null };
  } catch {
    return null;
  }
}

/** Send AS the connected user (Graph sendMail). Throws on failure. The
 *  message carries no From: Graph sends as the signed-in mailbox. */
export async function graphSendAsUser(
  accessToken: string,
  input: MessageInput,
): Promise<EmailSendReceipt> {
  const recipients = (list?: string[]) =>
    (list ?? []).map((address) => ({ emailAddress: { address } }));

  const res = await fetch(`${GRAPH_BASE}/me/sendMail`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: {
        subject: input.subject,
        body: input.html
          ? { contentType: 'HTML', content: input.html }
          : { contentType: 'Text', content: input.text },
        toRecipients: recipients(input.to),
        ...(input.cc?.length ? { ccRecipients: recipients(input.cc) } : {}),
        ...(input.bcc?.length ? { bccRecipients: recipients(input.bcc) } : {}),
        ...(input.attachments?.length
          ? {
              attachments: input.attachments.map((a) => ({
                '@odata.type': '#microsoft.graph.fileAttachment',
                name: a.filename,
                contentBytes: a.contentBase64,
                ...(a.contentType ? { contentType: a.contentType } : {}),
              })),
            }
          : {}),
      },
      saveToSentItems: true,
    }),
  });
  // The status and Graph's error code, never its message: it can quote the
  // recipient, the subject or an attachment name.
  if (!res.ok) throw new UpstreamHttpError('graph-mail', 'sendMail', res.status, await upstreamErrorCode(res));
  // Graph returns 202 with no body; the receipt id is synthetic.
  return { id: `graph-${Date.now().toString(36)}`, provider: 'graph' };
}

/**
 * Send through a connected Microsoft mailbox row, as its real address. The
 * dispatcher (./connectedSender) reads the row, checks Graph is configured
 * and calls this only for provider 'microsoft'. A connected mailbox is
 * authoritative: a failure THROWS (never silently falls back to the shared
 * address, which would change the sender identity). Tokens are refreshed on
 * every send and re-stored (Microsoft rotates them).
 */
export async function sendViaGraph(
  admin: SupabaseClient,
  row: { id: string; tokens_encrypted: string | null },
  input: MessageInput,
): Promise<EmailSendReceipt> {
  const stored = row.tokens_encrypted ? decryptTokens<GraphTokens>(row.tokens_encrypted) : null;
  if (!stored) throw new OperatorCopyError('Mailbox connection unreadable; reconnect the mailbox');

  const fresh = await refreshGraphTokens(stored.refreshToken);
  if (!fresh) throw new OperatorCopyError('Mailbox connection expired; reconnect the mailbox');

  await admin
    .from('mailbox_connections')
    .update({ tokens_encrypted: encryptTokens(fresh), updated_at: new Date().toISOString() })
    .eq('id', row.id);

  return graphSendAsUser(fresh.accessToken, input);
}
