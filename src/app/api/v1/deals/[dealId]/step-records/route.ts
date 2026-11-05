import { NextResponse } from 'next/server';

import { userCanAccessDeal } from '@/lib/api/v1/access';
import { jsonError, requireApiUser } from '@/lib/api/v1/http';
import { dealNotVisible } from '@/lib/api/v1/dealNotVisible';
import { STEP_STATUS } from '@/lib/constants/dealSteps';
import { TABLE } from '@/lib/constants/tables';
import { loadDealByIdOrCode } from '@/lib/dataroom/steps';
import type { DealStepRecord, DealStepSkipRecord } from '@/lib/rail/dealStepRecord';

type RouteContext = { params: Promise<{ dealId: string }> };

type StepRow = {
  step_id: string;
  seq: number;
  status: string;
  assigned_to: string | null;
  completed_by: string | null;
  completed_at: string | null;
  completion_note: string | null;
  work: Record<string, unknown> | null;
};

type NamedUser = {
  id: string;
  display_name: string | null;
  full_name: string | null;
  email: string | null;
};

function nameOf(user: NamedUser | undefined): string | null {
  if (!user) return null;
  return user.display_name?.trim() || user.full_name?.trim() || user.email || null;
}

function skipOf(status: string, work: Record<string, unknown> | null): DealStepSkipRecord | null {
  // `work` is editable under a weaker capability than closing a step; only
  // a row the platform closed as skipped carries a skip record.
  if (status !== STEP_STATUS.SKIPPED) return null;
  const raw = work?.skip;
  if (!raw || typeof raw !== 'object') return null;
  const skip = raw as Record<string, unknown>;
  const approver = typeof skip.approver === 'string' ? skip.approver : '';
  const reason = typeof skip.reason === 'string' ? skip.reason : '';
  if (!approver || !reason) return null;
  return {
    approver,
    approverRole: typeof skip.approverRole === 'string' ? skip.approverRole : '',
    reason,
    at: typeof skip.at === 'string' ? skip.at : '',
  };
}

/**
 * GET /api/v1/deals/{dealId}/step-records — every step's record on this
 * deal: status, assignee, completer (by name) and the logged skip. The rail
 * reads it once to credit "Completed by" and to show skips approved anywhere.
 */
export async function GET(_request: Request, context: RouteContext) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const { dealId } = await context.params;

  let deal;
  try {
    deal = await loadDealByIdOrCode(auth.admin, dealId);
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : 'Failed to resolve deal', 500);
  }
  if (!deal) return jsonError('Deal not found', 404);

  const allowed = await userCanAccessDeal(auth.admin, auth.user.id, deal.id);
  if (!allowed) return dealNotVisible();

  const { data: rows, error } = await auth.admin
    .from(TABLE.DEAL_STEPS)
    .select('step_id, seq, status, assigned_to, completed_by, completed_at, completion_note, work')
    .eq('deal_id', deal.id)
    .order('seq', { ascending: true });
  if (error) return jsonError(error.message, 500);

  const steps = (rows ?? []) as StepRow[];
  const userIds = Array.from(
    new Set(steps.flatMap((s) => [s.assigned_to, s.completed_by]).filter((id): id is string => Boolean(id))),
  );

  const users = new Map<string, NamedUser>();
  if (userIds.length > 0) {
    const { data: people, error: peopleError } = await auth.admin
      .from('users')
      .select('id, display_name, full_name, email')
      .in('id', userIds);
    if (peopleError) return jsonError(peopleError.message, 500);
    for (const person of (people ?? []) as NamedUser[]) users.set(person.id, person);
  }

  const records: DealStepRecord[] = steps.map((s) => ({
    stepId: s.step_id,
    seq: s.seq,
    status: s.status,
    assignedTo: s.assigned_to,
    assignedToName: s.assigned_to ? nameOf(users.get(s.assigned_to)) : null,
    completedBy: s.completed_by,
    completedByName: s.completed_by ? nameOf(users.get(s.completed_by)) : null,
    completedAt: s.completed_at,
    completionNote: s.completion_note,
    skip: skipOf(s.status, s.work),
  }));

  return NextResponse.json({ records });
}
