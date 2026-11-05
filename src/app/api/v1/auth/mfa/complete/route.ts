import { NextResponse } from 'next/server';

import { requireApiUser } from '@/lib/api/v1/http';
import { AUDIT_ACTION } from '@/lib/constants/audit';

const MFA_EVENTS = new Set<string>([
  AUDIT_ACTION.MFA_ENROLLED,
  AUDIT_ACTION.MFA_CHALLENGED,
]);

export async function POST(request: Request) {
  // Never record a successful MFA event from an AAL1 session, even when the
  // development policy exempts established accounts from routine challenges.
  const auth = await requireApiUser({ allowInvited: true, forceAal2: true });
  if (!auth.ok) return auth.response;

  let event: string | undefined;
  try {
    const body = (await request.json()) as { event?: unknown };
    event = typeof body.event === 'string' ? body.event : undefined;
  } catch {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  if (!event || !MFA_EVENTS.has(event)) {
    return NextResponse.json({ error: 'invalid_mfa_event' }, { status: 400 });
  }

  const { error } = await auth.admin.from('audit_log').insert({
    actor_id: auth.user.id,
    action: event,
    detail: {
      outcome: 'success',
      target_user_id: auth.user.id,
    },
  });
  if (error) {
    return NextResponse.json({ error: 'audit_failed' }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
