import type { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  classifyInternalUser,
  resolveDealStepCapabilities,
  userCanAccessDeal,
} from '@/lib/api/v1/access';
import { jsonError, requireApiUser, type ApiUser } from '@/lib/api/v1/http';
import { dealNotVisible } from '@/lib/api/v1/dealNotVisible';
import { TABLE } from '@/lib/constants/tables';
import { loadDealByIdOrCode } from '@/lib/dataroom/steps';
import { requireFlag } from '@/lib/flags/requireFlag';

export type RevisionAccess = {
  admin: SupabaseClient;
  user: ApiUser;
  deal: { id: string; code: string };
  step: { dealStepId: string; stepKey: string; title: string | null };
};

type Gate = { ok: true; ctx: RevisionAccess } | { ok: false; response: NextResponse };

const STEP_COLUMNS = 'id, step_id, removed_at, definition, assigned_to, status';

function refuse(message: string, status: number): Gate {
  return { ok: false, response: jsonError(message, status) };
}

export async function requireRevisionAccess(
  dealId: string,
  stepId: string,
  mode: 'read' | 'write',
): Promise<Gate> {
  for (const flag of ['skill_authoring', 'skill_output_revisions'] as const) {
    const gate = await requireFlag(flag);
    if (gate) return { ok: false, response: gate };
  }

  const auth = await requireApiUser();
  if (!auth.ok) return { ok: false, response: auth.response };

  const deal = await loadDealByIdOrCode(auth.admin, dealId);
  if (!deal) return refuse('Deal not found', 404);
  if (!(await userCanAccessDeal(auth.admin, auth.user.id, deal.id))) {
    return { ok: false, response: dealNotVisible() };
  }

  const wall = await classifyInternalUser(auth.admin, auth.user.id);
  if (wall === 'error') return refuse('Profile lookup failed', 500);
  if (wall !== 'internal') return refuse('Forbidden', 403);

  const { data } = await auth.admin
    .from(TABLE.DEAL_STEPS)
    .select(STEP_COLUMNS)
    .eq('deal_id', deal.id)
    .eq('step_id', stepId)
    .maybeSingle();
  const row = data as Record<string, unknown> | null;
  if (!row || typeof row.id !== 'string') return refuse('Unknown step', 404);

  if (mode === 'write') {
    if (row.removed_at) return refuse('This step was removed', 409);
    const capabilities = await resolveDealStepCapabilities(auth.admin, auth.user.id, deal.id, {
      assigned_to: (row.assigned_to as string | null) ?? null,
      status: (row.status as string) ?? 'pending',
    });
    if (capabilities === 'unreadable') return refuse('Profile lookup failed', 500);
    if (!capabilities.canEditWork) return refuse('Not permitted to revise this output', 403);
  }

  const definition = row.definition as { title?: unknown } | null;
  return {
    ok: true,
    ctx: {
      admin: auth.admin,
      user: auth.user,
      deal: { id: deal.id, code: deal.code },
      step: {
        dealStepId: row.id,
        stepKey: stepId,
        title: typeof definition?.title === 'string' ? definition.title : null,
      },
    },
  };
}
