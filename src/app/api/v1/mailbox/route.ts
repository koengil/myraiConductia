import { NextResponse } from 'next/server';
import { jsonError, requireApiUser } from '@/lib/api/v1/http';
import { MAILBOX_DISCONNECT_FAILED_COPY, MAILBOX_UNAVAILABLE_COPY } from '@/lib/constants/mailboxSend';
import { gmailSendConfigured } from '@/lib/email/gmail';
import { graphConfigured } from '@/lib/email/graph';
import { errorCodeOf } from '@/lib/errors/upstream';
import { requireFlag } from '@/lib/flags/requireFlag';

/**
 * /api/v1/mailbox — the caller's sending mailbox connection.
 *   GET    -> { configured, connected, email?, provider?, connectedAt?,
 *             status?, providers: { microsoft, google } }. configured = at
 *             least one sending client is configured on this deployment (the
 *             Azure app or the Google sending client); `providers` says which,
 *             and the Mail settings card offers a connect per provider (#490
 *             R25). connected = a connection that can send (status
 *             'connected'); a Google one whose approval ended reads status
 *             'revoked'.
 *   DELETE -> disconnect: deletes the row and its stored, encrypted tokens,
 *             whatever the provider or status. It does not revoke at the
 *             provider (owner's guide; #490 T3). A Google disconnect is
 *             audited as mailbox.disconnected ({provider} only), in the same
 *             transaction as the delete; a failure is a 500 that changed
 *             nothing.
 */

type ConnectionRow = { email: string; provider: string; status: string; connected_at: string };

export async function GET() {
  const gate = await requireFlag('mail_channel');
  if (gate) return gate;
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const providers = { microsoft: graphConfigured(), google: gmailSendConfigured() };
  const configured = providers.microsoft || providers.google;

  const { data, error } = await auth.admin
    .from('mailbox_connections')
    .select('email, provider, status, connected_at')
    .eq('user_id', auth.user.id)
    .maybeSingle();
  if (error) return jsonError(MAILBOX_UNAVAILABLE_COPY, 500);

  // A Microsoft row without the Azure app sends from the platform address, so
  // it reads as not connected, as before. A Google row is always reported:
  // with providers.google false the card says Gmail sending is switched off.
  const row = data as ConnectionRow | null;
  const shown = row && (row.provider !== 'microsoft' || providers.microsoft) ? row : null;

  return NextResponse.json({
    configured,
    connected: shown?.status === 'connected',
    ...(shown
      ? { email: shown.email, provider: shown.provider, connectedAt: shown.connected_at, status: shown.status }
      : {}),
    providers,
  });
}

export async function DELETE() {
  const gate = await requireFlag('mail_channel');
  if (gate) return gate;
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  // One RPC deletes the row and, for a Google row, writes mailbox.disconnected
  // in the same transaction (#490 audit 2). A failure changes nothing, so the
  // card's "still connected" is true and a retry audits. Graph connect and
  // disconnect are not audited yet (#490 T5).
  const { error } = await auth.admin.rpc('mailbox_sending_disconnect', { p_user: auth.user.id });
  if (error) {
    console.error('[mailbox] disconnect failed', { code: errorCodeOf(error) });
    return jsonError(MAILBOX_DISCONNECT_FAILED_COPY, 500);
  }

  return new NextResponse(null, { status: 204 });
}
