import { NextResponse } from 'next/server';

import { jsonError } from '@/lib/api/v1/http';
import { requireApiUserScoped, type ScopedApiUser } from '@/lib/api/v1/httpScoped';
import { requireFlag } from '@/lib/api/v1/requireFlag';

export const dynamic = 'force-dynamic';

type Scoped = Extract<ScopedApiUser, { ok: true }>;

const MAX_ADDRESS_LENGTH = 400;

/**
 * GET/POST/DELETE /api/v1/discovery/sites: the firm admin's SharePoint site
 * allowlist (#262, R23). A site is read only while an active, internal firm
 * admin has registered its address. Every call runs under the caller's
 * session; the RPCs check the caller's role, act on the caller's own firm and
 * audit each change. No admin client is built here.
 *
 * GET and POST sit behind `deal_discovery`. DELETE never does (C16): withdrawal
 * is always reachable, as it is for mailbox consent, so an admin can stop a
 * registered site while the flag is off. The worker reads nothing while it is off.
 */
async function list(auth: Scoped) {
  const { data, error } = await auth.db.rpc('discovery_site_registrations');
  if (error) {
    if (error.code === '42501' && error.message === 'not_authorized') return jsonError('not_authorized', 403);
    return jsonError('Could not load site registrations', 500);
  }
  return NextResponse.json({ sites: data ?? [] });
}

/** The request body's `address`, or null when it is missing, not a string or oversized. */
async function readAddress(request: Request): Promise<string | null> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return null;
  }
  if (typeof body !== 'object' || body === null) return null;
  const address = (body as { address?: unknown }).address;
  if (typeof address !== 'string' || address.trim() === '' || address.length > MAX_ADDRESS_LENGTH) return null;
  return address;
}

/** Maps the RPCs' exact error code and message pairs; anything else is a 500. */
function rpcFailure(error: { code?: string; message: string }, fallback: string) {
  if (error.code === '42501' && (error.message === 'not_authorized' || error.message === 'not_authenticated')) {
    return jsonError(error.message, 403);
  }
  if (error.code === '22023' && error.message === 'invalid_site_address') return jsonError('invalid_site_address', 400);
  if (error.code === 'P0001' && error.message === 'registered_by_other_firm') {
    return jsonError('registered_by_other_firm', 409);
  }
  return jsonError(fallback, 500);
}

export async function GET() {
  const gate = await requireFlag('deal_discovery');
  if (gate) return gate;
  const auth = await requireApiUserScoped();
  if (!auth.ok) return auth.response;
  return list(auth);
}

export async function POST(request: Request) {
  const gate = await requireFlag('deal_discovery');
  if (gate) return gate;
  const auth = await requireApiUserScoped();
  if (!auth.ok) return auth.response;
  const address = await readAddress(request);
  if (address === null) return jsonError('address is required', 400);
  const { error } = await auth.db.rpc('site_register', { p_address: address });
  if (error) return rpcFailure(error, 'Could not register the site');
  return list(auth);
}

export async function DELETE(request: Request) {
  const auth = await requireApiUserScoped();
  if (!auth.ok) return auth.response;
  const address = await readAddress(request);
  if (address === null) return jsonError('address is required', 400);
  const { error } = await auth.db.rpc('site_unregister', { p_address: address });
  if (error) return rpcFailure(error, 'Could not unregister the site');
  return list(auth);
}
