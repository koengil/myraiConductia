import { NextResponse } from 'next/server';

import { jsonError } from '@/lib/api/v1/http';
import { requireApiUserScoped, type ScopedApiUser } from '@/lib/api/v1/httpScoped';
import { requireFlag } from '@/lib/api/v1/requireFlag';

export const dynamic = 'force-dynamic';

type Scoped = Extract<ScopedApiUser, { ok: true }>;

/**
 * GET/POST/DELETE /api/v1/discovery/mailbox-consent: the caller's own
 * "Connect my mailbox" opt-in (#262). Every call runs under the caller's
 * session; the RPCs act on auth.uid() only and audit each change.
 *
 * Only POST (connect) sits behind `deal_discovery`. GET and DELETE never do:
 * withdrawal is always reachable, so a member who consented can see it and
 * stop it while the flag is off (audit round 1, item 20). The worker also
 * reads nothing while the flag is off.
 *
 * DELETE also deletes the mail stored from the caller's mailbox (#461), and
 * its body adds `purged`: what that deleted, as counts, or null when
 * there was no mailbox source to purge.
 */
async function status(auth: Scoped, extra?: Record<string, unknown>) {
  const { data, error } = await auth.db.rpc('mailbox_consent_status');
  if (error) return jsonError('Could not load mailbox consent', 500);
  return NextResponse.json(extra ? { ...(data as Record<string, unknown>), ...extra } : data);
}

export async function GET() {
  const auth = await requireApiUserScoped();
  if (!auth.ok) return auth.response;
  return status(auth);
}

export async function POST() {
  const gate = await requireFlag('deal_discovery');
  if (gate) return gate;
  const auth = await requireApiUserScoped();
  if (!auth.ok) return auth.response;
  const { error } = await auth.db.rpc('mailbox_consent_grant');
  if (error) {
    // Exact: the RPC raises 'not_eligible' with SQLSTATE 42501 (review round 5).
    if (error.code === '42501' && error.message === 'not_eligible') return jsonError('not_eligible', 403);
    return jsonError('Could not save mailbox consent', 500);
  }
  return status(auth);
}

export async function DELETE() {
  const auth = await requireApiUserScoped();
  if (!auth.ok) return auth.response;
  const { data, error } = await auth.db.rpc('mailbox_consent_withdraw');
  if (error) return jsonError('Could not withdraw mailbox consent', 500);
  return status(auth, { purged: (data as { purged?: unknown } | null)?.purged ?? null });
}
