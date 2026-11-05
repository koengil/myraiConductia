import { NextResponse } from 'next/server';

import { jsonError } from '@/lib/api/v1/http';
import { requireApiUserScoped } from '@/lib/api/v1/httpScoped';
import { requireFlag } from '@/lib/api/v1/requireFlag';
import { readDealThread, replyThreading } from '@/lib/discovery/api';
import { mintReplyToken } from '@/lib/email/replyToken';

export const dynamic = 'force-dynamic';

const MAX_CODE_LENGTH = 64;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/v1/discovery/deal-email/thread?deal=<code>&item=<sourceItemId>: the
 * conversation a deal-linked message belongs to, for the Deal email view (#339).
 * Read under RLS with the caller's own session, and only from the caller's own
 * mailbox: a colleague's message in the conversation is left out. An unknown or
 * unseen deal, a message not linked to it, and a message the caller does not own
 * all answer the same 404, so the route is no oracle for which mail exists.
 * The response adds replyToken (src/lib/email/replyToken.ts): the threading a
 * reply to the newest message carries, signed for the caller and the deal.
 */
export async function GET(request: Request) {
  const gate = await requireFlag('deal_discovery');
  if (gate) return gate;

  const auth = await requireApiUserScoped();
  if (!auth.ok) return auth.response;

  const params = new URL(request.url).searchParams;
  const deal = params.get('deal')?.trim() ?? '';
  const item = params.get('item')?.trim() ?? '';
  if (!deal || deal.length > MAX_CODE_LENGTH) return jsonError('deal is required', 400);
  if (!UUID.test(item)) return jsonError('item is required', 400);

  // The sign-in address marks the caller's own sends; readDealThread adds their connected mailbox's address.
  const result = await readDealThread(auth.db, deal, item, [auth.user.email]);
  if (!result.ok) return jsonError('Could not load the thread', 500);
  if (!result.thread) return jsonError('Not found', 404);

  // A reply to the newest message carries its threading through a signed token: the outbox verifies it and never
  // reads mailbox data itself. Null (the reply goes out unthreaded) when the newest message has no usable id.
  const threading = replyThreading(result.thread);
  const newest = result.thread.messages.at(-1);
  const replyToken =
    threading && newest
      ? mintReplyToken({
          actorId: auth.user.id,
          dealCode: deal.toUpperCase(),
          sourceItemId: newest.sourceItemId,
          ...threading,
          participants: result.participants ?? [],
          iat: Date.now(),
        })
      : null;
  return NextResponse.json({ ...result.thread, replyToken });
}
