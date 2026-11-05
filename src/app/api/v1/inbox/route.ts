import { NextResponse } from 'next/server';
import { firmMailAccess } from '@/lib/api/v1/access';
import { resolveDealRefLenient, type LenientDealRef } from '@/lib/api/v1/dealRef';
import { jsonError, requireApiUser } from '@/lib/api/v1/http';
import { requireFlag } from '@/lib/flags/requireFlag';

/**
 * GET /api/v1/inbox — mail received by the platform channel, newest first.
 * Bank-side only (firmMailAccess: no external users, walls apply); scoped to
 * the caller's tenant, optionally narrowed to one deal via ?dealId (resolved
 * leniently — a deal the caller cannot see answers exactly like a miss of the
 * same shape: a deal-shaped ref shows untagged mail only, any other ref, such
 * as a sandbox slug, means no filter). UNTAGGED inbound
 * stays visible under any deal filter: the webhook leaves deal_id null until
 * the per-project address scheme lands, so an exact-match filter would blank
 * every real project's Inbox — a received message must never disappear.
 */

const INBOX_SELECT =
  'id, deal_id, from_email, to_email, cc_emails, subject, body, body_html, attachments, ' +
  'provider, received_at, read_at';

export type InboundRow = {
  id: string;
  deal_id: string | null;
  from_email: string;
  to_email: string;
  cc_emails: string[] | null;
  subject: string;
  body: string;
  body_html: string | null;
  attachments: unknown;
  provider: string | null;
  received_at: string;
  read_at: string | null;
};

export function toApiInbound(row: InboundRow) {
  return {
    id: row.id,
    dealId: row.deal_id,
    from: row.from_email,
    to: row.to_email,
    cc: row.cc_emails ?? [],
    subject: row.subject,
    body: row.body,
    bodyHtml: row.body_html,
    attachments: Array.isArray(row.attachments) ? row.attachments : [],
    provider: row.provider,
    receivedAt: row.received_at,
    read: Boolean(row.read_at),
  };
}

export async function GET(request?: Request) {
  const gate = await requireFlag('mail_channel');
  if (gate) return gate;
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const access = await firmMailAccess(auth.admin, auth.user.id);
  if (!access.ok || !access.tenantId) return jsonError('Forbidden', 403);

  let dealRef: LenientDealRef = { kind: 'slug' };
  if (request) {
    try {
      dealRef = await resolveDealRefLenient(
        auth.admin,
        auth.user.id,
        new URL(request.url).searchParams.get('dealId'),
      );
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : 'Deal lookup failed', 500);
    }
  }

  let query = auth.admin
    .from('inbound_messages')
    .select(INBOX_SELECT)
    .eq('tenant_id', access.tenantId);
  // Tagged rows scope to the deal; untagged rows (all inbound today) stay
  // visible everywhere. The id is a resolved UUID, safe in the or() filter.
  // A deal the caller cannot see, or a deal-shaped ref that matches nothing,
  // keeps only the untagged rows: the same answer for both (D65, #245).
  if (dealRef.kind === 'deal') query = query.or(`deal_id.eq.${dealRef.id},deal_id.is.null`);
  if (dealRef.kind === 'hidden') query = query.is('deal_id', null);

  const { data, error } = await query
    .order('received_at', { ascending: false })
    .limit(50);
  if (error) return jsonError(error.message, 500);

  return NextResponse.json({
    messages: ((data ?? []) as unknown as InboundRow[]).map(toApiInbound),
  });
}
