import { NextResponse } from 'next/server';

import { isUuid, jsonError } from '@/lib/api/v1/http';
import { requireApiUserScoped } from '@/lib/api/v1/httpScoped';
import { requireFlag } from '@/lib/api/v1/requireFlag';

export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/discovery/mailbox-sources/unify: a firm admin merges an archived
 * mailbox source into the live source of the address it was archived from
 * (#262, audit round 3, D1). When an address is reassigned, the next holder's
 * opt-in archives the earlier holder's source (and its stored items) under
 * `<address>~xyz` and starts a fresh one; this is the only way that history
 * reaches the new holder. The call runs under the caller's session; the RPC
 * checks the caller is an active, internal firm admin of the bank's own firm,
 * that both sources are in the caller's tenant, that the target is active, on
 * the archived row's provider and owned by an allowlisted user, and audits the
 * merge. No admin client is built here.
 *
 * Behind `deal_discovery`, like registering a site: a merge widens who sees
 * stored mail, so it is never a withdrawal path. The RPC tests the flag too.
 */
async function readIds(request: Request): Promise<{ archived: string; target: string } | null> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return null;
  }
  if (typeof body !== 'object' || body === null) return null;
  const { archivedSourceId, targetSourceId } = body as { archivedSourceId?: unknown; targetSourceId?: unknown };
  if (typeof archivedSourceId !== 'string' || !isUuid(archivedSourceId)) return null;
  if (typeof targetSourceId !== 'string' || !isUuid(targetSourceId)) return null;
  return { archived: archivedSourceId, target: targetSourceId };
}

/** The RPC's exact error code and message pairs; anything else is a 500. */
function rpcFailure(error: { code?: string; message: string }) {
  if (error.code === '42501' && (error.message === 'not_authorized' || error.message === 'not_authenticated')) {
    return jsonError(error.message, 403);
  }
  if (error.code === '22023' && error.message === 'invalid_unify_request') return jsonError('invalid_unify_request', 400);
  if (error.code === 'P0001') {
    if (error.message === 'unify_source_not_found') return jsonError('unify_source_not_found', 404);
    // The RPC repeats the route's flag test, so a direct caller gets the same answer: as if it never shipped.
    if (error.message === 'unify_discovery_disabled') return jsonError('Not found', 404);
    if (
      error.message === 'unify_not_archived' ||
      error.message === 'unify_already_unified' ||
      error.message === 'unify_address_mismatch' ||
      error.message === 'unify_target_not_active' ||
      error.message === 'unify_provider_mismatch' ||
      error.message === 'unify_target_not_allowlisted'
    ) {
      return jsonError(error.message, 409);
    }
  }
  return jsonError('Could not merge the mailbox sources', 500);
}

export async function POST(request: Request) {
  const gate = await requireFlag('deal_discovery');
  if (gate) return gate;
  const auth = await requireApiUserScoped();
  if (!auth.ok) return auth.response;
  const ids = await readIds(request);
  if (ids === null) return jsonError('archivedSourceId and targetSourceId are required', 400);
  const { data, error } = await auth.db.rpc('discovery_unify_mailbox_sources', {
    p_archived: ids.archived,
    p_target: ids.target,
  });
  if (error) return rpcFailure(error);
  return NextResponse.json(data);
}
