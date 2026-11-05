// The shared front of the four correction routes (rename, reject, step,
// merge): flag gate, the caller's own session, the candidate id in the path and
// the JSON body. Nothing here reads data or names a table; each route calls one
// wrapper in ./api, whose RPC acts on auth.uid() and checks tenant, visibility
// and deal-create authority itself.

import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';

import { isUuid, jsonError } from '@/lib/api/v1/http';
import { requireApiUserScoped } from '@/lib/api/v1/httpScoped';
import { requireFlag } from '@/lib/api/v1/requireFlag';

import { correctionErrorStatus, type CorrectionResult } from './api';

export const MAX_REASON_LENGTH = 1000;
export const MAX_NAME_LENGTH = 120;

export type CorrectionRequest =
  | { ok: true; db: SupabaseClient; candidateId: string; body: Record<string, unknown> }
  | { ok: false; response: NextResponse };

export async function readCorrectionRequest(
  request: Request,
  context: { params: Promise<{ candidateId: string }> },
): Promise<CorrectionRequest> {
  const gate = await requireFlag('deal_discovery');
  if (gate) return { ok: false, response: gate };
  const auth = await requireApiUserScoped();
  if (!auth.ok) return { ok: false, response: auth.response };
  const { candidateId } = await context.params;
  if (!isUuid(candidateId)) return { ok: false, response: jsonError('Proposed deal not found', 404) };
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { ok: false, response: jsonError(correctionErrorStatus('22023').error, 400) };
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, response: jsonError(correctionErrorStatus('22023').error, 400) };
  }
  return { ok: true, db: auth.db, candidateId, body: body as Record<string, unknown> };
}

/** A non-blank string of at most `max` characters, trimmed, or null. */
export function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : null;
}

export const badFields = () => jsonError(correctionErrorStatus('22023').error, 400);

/** The route's answer for one wrapper's result: the correction id, or the mapped error. */
export function correctionResponse(result: CorrectionResult): NextResponse {
  if (result.ok) return NextResponse.json({ correctionId: result.correctionId });
  const { status, error } = correctionErrorStatus(result.code, result.message);
  return jsonError(error, status);
}
