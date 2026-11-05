import type { NextResponse } from 'next/server';
import { isEnabled } from '@/lib/flags/isEnabled';
import { supabaseFlagSource } from '@/lib/flags/supabaseSource';
import type { FlagKey } from '@/lib/flags/keys';
import { jsonError } from './http';

/**
 * Server-side flag gate for /api/v1 routes (plan-v5 M-flag). Flag-off means:
 * new routes 404 as if they never shipped; routes with flag-BRANCHED behavior
 * call `isFlagEnabled` instead and keep their pre-flag path. Fail-closed via
 * isEnabled (ADR-0007).
 */
export async function requireFlag(key: FlagKey): Promise<NextResponse | null> {
  const enabled = await isEnabled(key, supabaseFlagSource);
  return enabled ? null : jsonError('Not found', 404);
}

export async function isFlagEnabled(key: FlagKey): Promise<boolean> {
  return isEnabled(key, supabaseFlagSource);
}
