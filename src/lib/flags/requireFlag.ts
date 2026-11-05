import { NextResponse } from 'next/server';
import { isEnabled } from './isEnabled';
import type { FlagKey } from './keys';
import { supabaseFlagSource } from './supabaseSource';

/**
 * Server-side flag gate for API routes (ADR-0007 fail-closed): returns a 404
 * response when the flag is off — the route does not exist until the
 * capability is switched on — or null to proceed. 404 (not 403) so a disabled
 * surface is indistinguishable from an absent one.
 *
 *   const gate = await requireFlag('mail_channel');
 *   if (gate) return gate;
 */
export async function requireFlag(key: FlagKey): Promise<NextResponse | null> {
  if (await isEnabled(key, supabaseFlagSource)) return null;
  return NextResponse.json({ error: 'Not found' }, { status: 404 });
}
