import { NextResponse } from 'next/server';

import { jsonError } from '@/lib/api/v1/http';
import { requireApiUserScoped } from '@/lib/api/v1/httpScoped';
import { requireFlag } from '@/lib/api/v1/requireFlag';
import { TEAM_MAILBOX_ATTESTATION_VERSION } from '@/lib/constants/discovery';
import { connectTeamMailbox, listTeamMailboxes, type ConnectTeamMailboxFailure } from '@/lib/discovery/api';

export const dynamic = 'force-dynamic';

const MAX_ADDRESS_LENGTH = 400;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * GET/POST /api/v1/discovery/team-mailboxes: the firm admin's team inboxes (#581). A team inbox
 * (deals@) is a shared mailbox nobody signs in as, so a firm admin registers it instead of a
 * person opting in. Every call runs under the caller's session; the RPCs act on auth.uid(),
 * check that the caller is the firm's active, internal admin, and audit by ids and fixed codes.
 * No admin client is built here.
 *
 * Both sit behind `deal_discovery`. The inbox is read only after the worker has checked the
 * address in the Google Directory and while that check is fresh; this route reads nothing.
 * DELETE of a registration is in ./[teamMailboxId]/route.ts.
 */

/** A real calendar day written `YYYY-MM-DD`, or null. The RPC bounds the range. */
function parseDay(value: string): string | null {
  const match = DAY.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  const real = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return real ? value : null;
}

type Body = { address: string; attestationVersion: number; backfillSince: string | null };

/** The request body, or the 400 that says what is wrong with it. */
async function readBody(request: Request): Promise<{ ok: true; body: Body } | { ok: false; response: NextResponse }> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { ok: false, response: jsonError('Invalid JSON body', 400) };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, response: jsonError('Invalid JSON body', 400) };
  }
  const { address, attestationVersion, backfillSince } = raw as Record<string, unknown>;
  if (typeof address !== 'string' || address.length > MAX_ADDRESS_LENGTH) {
    return { ok: false, response: jsonError('address is required', 400) };
  }
  if (typeof attestationVersion !== 'number' || !Number.isInteger(attestationVersion)) {
    return { ok: false, response: jsonError('attestationVersion is required', 400) };
  }
  let day: string | null = null;
  if (backfillSince !== undefined && backfillSince !== null) {
    day = typeof backfillSince === 'string' ? parseDay(backfillSince) : null;
    if (day === null) return { ok: false, response: jsonError('backfillSince must be a date, YYYY-MM-DD', 400) };
  }
  return { ok: true, body: { address, attestationVersion, backfillSince: day } };
}

/** Each refusal the connect RPC names, as the status and code the admin card reads. */
const REFUSAL_STATUS: Record<Exclude<ConnectTeamMailboxFailure, 'error' | 'discovery_disabled'>, number> = {
  not_eligible: 403,
  person_address: 409,
  provider_unresolved: 422,
  provider_unsupported: 422,
  out_of_range: 422,
  invalid_address: 422,
  attestation_required: 422,
};

export async function GET() {
  const gate = await requireFlag('deal_discovery');
  if (gate) return gate;
  const auth = await requireApiUserScoped();
  if (!auth.ok) return auth.response;

  const result = await listTeamMailboxes(auth.db);
  if (result.ok) return NextResponse.json({ teamMailboxes: result.teamMailboxes });
  // One 404 for "not the firm's admin": the caller learns nothing about the firm's inboxes.
  return result.reason === 'not_available'
    ? jsonError('Not found', 404)
    : jsonError('Could not load the team inboxes', 500);
}

export async function POST(request: Request) {
  const gate = await requireFlag('deal_discovery');
  if (gate) return gate;
  const auth = await requireApiUserScoped();
  if (!auth.ok) return auth.response;

  const parsed = await readBody(request);
  if (!parsed.ok) return parsed.response;
  const { address, attestationVersion, backfillSince } = parsed.body;
  // The attestation is the version of the text on screen. A client on an older text must reload.
  if (attestationVersion !== TEAM_MAILBOX_ATTESTATION_VERSION) return jsonError('attestation_required', 422);

  const result = await connectTeamMailbox(auth.db, { address, attestationVersion, backfillSince });
  if (result.ok) {
    return NextResponse.json({ teamMailbox: result.teamMailbox }, { status: result.created ? 201 : 200 });
  }
  if (result.reason === 'discovery_disabled') return jsonError('Not found', 404);
  if (result.reason === 'error') return jsonError('Could not connect the team inbox', 500);
  return jsonError(result.reason, REFUSAL_STATUS[result.reason]);
}
