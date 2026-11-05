import { createHash } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';

import { gmailReconnectError, gmailUnconfiguredError, mailboxChangedError } from '@/lib/constants/mailboxSend';
import type { OperatorCopyError } from '@/lib/errors/upstream';
import { gmailSendConfigured, sendViaGmail } from './gmail';
import { graphConfigured, sendViaGraph } from './graph';
import type { EmailSendReceipt, MessageInput } from './transport';

/**
 * Which mailbox a send leaves from (#490). One sending mailbox per user
 * (mailbox_connections, unique user_id); its provider decides the path.
 *
 * The contract the outbox relies on: null means "no connected mailbox", so the
 * platform transport sends; a throw means the connected mailbox failed, which
 * is a 502 and never a switch of sender identity.
 *   - A read error throws (R21): it never reads as "no connection".
 *   - A Microsoft row with Graph unconfigured is null, as before.
 *   - A Google row never yields null (M3): no config, or an ended approval,
 *     refuses with fixed copy rather than sending from the platform address.
 *   - The row must still be the identity the outbox read before its screen
 *     (`expect`, R17): a connect or disconnect in between refuses, so a send
 *     never re-routes after the screen and its envelope binding.
 */

/** The caller's sending mailbox as the outbox reads it before the screen. Never carries tokens. */
export type SendingIdentity = { connectionId: string; provider: string; email: string; status: string };

type ConnectionRow = {
  id: string;
  user_id: string;
  provider: string;
  email: string;
  status: string;
  tokens_encrypted: string | null;
};

/** mailbox_connections could not be read. Its code reaches the 502 copy; the database's text never does. */
export class MailboxReadError extends Error {
  readonly code = 'mailbox_unavailable';

  constructor() {
    super('mailbox connection read failed');
    this.name = 'MailboxReadError';
  }
}

/** The caller's sending mailbox, or null when they have none. Throws MailboxReadError on a read error. */
export async function sendingIdentity(admin: SupabaseClient, userId: string): Promise<SendingIdentity | null> {
  const { data, error } = await admin
    .from('mailbox_connections')
    .select('id, provider, email, status')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new MailboxReadError();
  if (!data) return null;
  const row = data as Pick<ConnectionRow, 'id' | 'provider' | 'email' | 'status'>;
  return { connectionId: row.id, provider: row.provider, email: row.email, status: row.status };
}

/**
 * Why a send through this mailbox must not even be screened (R23): a Google
 * connection on an environment without the sending client, or one whose
 * approval has ended. Null for every other mailbox, and for none.
 */
export function connectedSendRefusal(identity: { provider: string; status: string } | null): OperatorCopyError | null {
  if (identity?.provider !== 'google') return null;
  if (!gmailSendConfigured()) return gmailUnconfiguredError();
  if (identity.status !== 'connected') return gmailReconnectError();
  return null;
}

/**
 * The digest a Gmail send-as-is token is bound to (R17): the recipients
 * (trimmed, lowercased, order kept) and the sending connection. The
 * connection is its row id, which every Connect for sending replaces, so a
 * disconnect and reconnect of the same address screens afresh (#490 audit 3).
 * A changed audience or mailbox screens afresh too.
 */
export function envelopeSha(
  recipients: { to: string[]; cc: string[]; bcc: string[] },
  identity: Pick<SendingIdentity, 'connectionId' | 'provider' | 'email'>,
): string {
  const norm = (list: string[]) => list.map((address) => address.trim().toLowerCase());
  return createHash('sha256')
    .update(
      JSON.stringify([
        norm(recipients.to),
        norm(recipients.cc),
        norm(recipients.bcc),
        identity.connectionId,
        identity.provider,
        identity.email,
      ]),
    )
    .digest('hex');
}

/** The connection, provider and email, null-safe: what must not change between the screen and the send. */
const identityKey = (identity: Pick<SendingIdentity, 'connectionId' | 'provider' | 'email'> | null) =>
  identity ? JSON.stringify([identity.connectionId, identity.provider, identity.email]) : null;

/**
 * Send through the caller's connected mailbox, as their real address. Null
 * when there is none (or a Microsoft one with Graph unconfigured): the caller
 * falls back to the platform transport. Throws on every other failure.
 */
export async function sendAsConnectedUser(
  admin: SupabaseClient,
  userId: string,
  message: MessageInput,
  opts: { expect: SendingIdentity | null },
): Promise<EmailSendReceipt | null> {
  const { data, error } = await admin
    .from('mailbox_connections')
    .select('id, user_id, provider, email, status, tokens_encrypted')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new MailboxReadError();
  const row = (data as ConnectionRow | null) ?? null;
  // Checked first: a connect or disconnect since the screen never re-routes the send. Status is not
  // compared: an approval that ended in between gets the reconnect copy below.
  // The row id is compared too: a reconnect of the same address replaces the row (#490 audit 3).
  const current = row ? { connectionId: row.id, provider: row.provider, email: row.email } : null;
  if (identityKey(current) !== identityKey(opts.expect)) throw mailboxChangedError();
  if (!row) return null;

  if (row.provider === 'microsoft') return graphConfigured() ? sendViaGraph(admin, row, message) : null;
  // The provider CHECK allows only microsoft and google; anything else fails closed.
  if (row.provider !== 'google') throw new MailboxReadError();

  const refusal = connectedSendRefusal(row);
  if (refusal) throw refusal;
  return sendViaGmail(admin, row, message);
}
