import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';

import { classifyInternalUser, userCanAccessDeal } from '@/lib/api/v1/access';
import { dealNotVisible } from '@/lib/api/v1/dealNotVisible';
import { jsonError, requireApiUser } from '@/lib/api/v1/http';
import { errorCodeOf } from '@/lib/errors/upstream';
import {
  dealDataroomStatus,
  loadDealByIdOrCode,
  provisionDealDataroomOnCreate,
  type DealRef,
} from '@/lib/dataroom/steps';

type RouteContext = { params: Promise<{ dealId: string }> };

type Gate =
  | { ok: true; admin: SupabaseClient; deal: DealRef }
  | { ok: false; response: NextResponse };

async function requireInternalMember(context: RouteContext): Promise<Gate> {
  const auth = await requireApiUser();
  if (!auth.ok) return auth;

  const { dealId } = await context.params;
  let deal: DealRef | null;
  try {
    deal = await loadDealByIdOrCode(auth.admin, dealId);
  } catch (err) {
    return { ok: false, response: jsonError(`Deal lookup failed (${errorCodeOf(err)})`, 500) };
  }
  if (!deal) return { ok: false, response: jsonError('Deal not found', 404) };
  if (!(await userCanAccessDeal(auth.admin, auth.user.id, deal.id))) {
    return { ok: false, response: dealNotVisible() };
  }

  const wall = await classifyInternalUser(auth.admin, auth.user.id);
  if (wall === 'error') return { ok: false, response: jsonError('Profile lookup failed', 500) };
  if (wall !== 'internal') return { ok: false, response: jsonError('Forbidden', 403) };
  return { ok: true, admin: auth.admin, deal };
}

export async function GET(_request: Request, context: RouteContext) {
  const gate = await requireInternalMember(context);
  if (!gate.ok) return gate.response;
  try {
    return NextResponse.json({ status: await dealDataroomStatus(gate.admin, gate.deal.id) });
  } catch (err) {
    return jsonError(`Data room status failed (${errorCodeOf(err)})`, 500);
  }
}

export async function POST(_request: Request, context: RouteContext) {
  const gate = await requireInternalMember(context);
  if (!gate.ok) return gate.response;
  const status = await provisionDealDataroomOnCreate(gate.admin, gate.deal.id, gate.deal.code);
  return status === 'ready'
    ? NextResponse.json({ status })
    : NextResponse.json({ status, error: 'Data room setup did not complete' }, { status: 502 });
}
