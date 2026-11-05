import { NextResponse } from 'next/server';

import type { SupabaseClient } from '@supabase/supabase-js';

import { classifyInternalUser, resolveDealStepCapabilities, userCanAccessDeal, userIsDealMd } from '@/lib/api/v1/access';
import {
  benchSessionOf,
  benchSessionPatch,
  type BenchSessionPatch,
} from '@/lib/api/v1/benchSession';
import { auditFailed, jsonError, requireApiUser } from '@/lib/api/v1/http';
import { dealNotVisible } from '@/lib/api/v1/dealNotVisible';
import {
  isSkipApproverIneligible,
  isSkipDeadlock,
  parseStepSkip,
  resolveSkipApprover,
  SKIP_APPROVER_INELIGIBLE_ANSWER,
  skipRetryResponse,
} from '@/lib/api/v1/stepSkip';
import { AUDIT_ACTION } from '@/lib/constants/audit';
import { STEP_STATUS } from '@/lib/constants/dealSteps';
import { TABLE } from '@/lib/constants/tables';
import { loadDealByIdOrCode, stepHasUpload } from '@/lib/dataroom/steps';
import { safeLogId } from '@/lib/errors/logSafe';
import { errorCodeOf } from '@/lib/errors/upstream';
import {
  notifyStepAssigned,
  notifyStepCompleted,
} from '@/lib/notifications/dealStepNotifications';
import { manualStepDef, validateManualWork } from '@/lib/rail/manualStepDefs';
import { orderedSteps } from '@/lib/rail/dealRail';
import { DbError, dbFailure } from '@/lib/errors/upstream';

type RouteContext = { params: Promise<{ dealId: string; stepId: string }> };

/** deal_step_save's SQLSTATE for a step that changed since it was read. */
const STEP_CHANGED = 'P0409';

const STEP_SELECT =
  'id, deal_id, step_id, seq, status, display_order, assigned_to, assigned_by, assigned_at, ' +
  'completed_by, completed_at, completion_note, work, updated_at, removed_at, ' +
  'bench_conversation_id, bench_run_id, bench_run_status, bench_run_started_at';

type DealStepRow = {
  id: string;
  deal_id: string;
  step_id: string;
  seq: number;
  display_order: number | null;
  status: string;
  assigned_to: string | null;
  assigned_by: string | null;
  assigned_at: string | null;
  completed_by: string | null;
  completed_at: string | null;
  completion_note: string | null;
  removed_at: string | null;
  work: Record<string, unknown> | null;
  updated_at: string;
  bench_conversation_id: string | null;
  bench_run_id: string | null;
  bench_run_status: string | null;
  bench_run_started_at: string | null;
};

async function resolveDeal(auth: Awaited<ReturnType<typeof requireApiUser>> & { ok: true }, dealId: string) {
  try {
    return await loadDealByIdOrCode(auth.admin, dealId);
  } catch (err) {
    // loadDealByIdOrCode already throws a code-only DbError; anything else becomes fixed copy.
    throw err instanceof DbError ? err : new Error('Failed to resolve deal');
  }
}

async function loadStepRow(
  admin: SupabaseClient,
  dealUuid: string,
  stepId: string,
): Promise<DealStepRow | null> {
  const { data, error } = await admin
    .from(TABLE.DEAL_STEPS)
    .select(STEP_SELECT)
    .eq('deal_id', dealUuid)
    .eq('step_id', stepId)
    .maybeSingle();
  if (error) throw dbFailure('Step lookup', error);
  return data as DealStepRow | null;
}

function actorName(user: { display_name?: string | null; full_name?: string | null; email?: string | null }) {
  return user.display_name?.trim() || user.full_name?.trim() || user.email || 'Banker';
}

function serializeStep(
  step: DealStepRow,
  assignee?: { id: string; name: string } | null,
  options?: { includeWork?: boolean; completedByName?: string | null },
) {
  return {
    stepId: step.step_id,
    seq: step.seq,
    status: step.status,
    assignedTo: step.assigned_to,
    assignedToName: assignee?.name ?? null,
    assignedAt: step.assigned_at,
    completedBy: step.completed_by,
    completedByName: options?.completedByName ?? null,
    completedAt: step.completed_at,
    completionNote: step.completion_note,
    work: options?.includeWork === false ? {} : (step.work ?? {}),
    benchSession: options?.includeWork === false ? null : benchSessionOf(step),
    /** The row version a client sends back as expectedUpdatedAt. */
    updatedAt: step.updated_at,
  };
}

/**
 * GET /api/v1/deals/{dealId}/steps/{stepId} — step assignment, work, completion.
 */
export async function GET(_request: Request, context: RouteContext) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const { dealId, stepId } = await context.params;

  let dealRef;
  try {
    dealRef = await resolveDeal(auth, dealId);
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : 'Failed to resolve deal', 500);
  }
  if (!dealRef) return jsonError('Deal not found', 404);

  const allowed = await userCanAccessDeal(auth.admin, auth.user.id, dealRef.id);
  if (!allowed) return dealNotVisible();

  const wall = await classifyInternalUser(auth.admin, auth.user.id);
  if (wall === 'error') return jsonError('Profile lookup failed', 500);
  const isInternal = wall === 'internal';

  const step = await loadStepRow(auth.admin, dealRef.id, stepId);
  if (!step) return jsonError('Step not found for this deal', 404);

  let assignee: { id: string; name: string } | null = null;
  if (step.assigned_to) {
    const { data: user } = await auth.admin
      .from('users')
      .select('id, display_name, full_name, email')
      .eq('id', step.assigned_to)
      .maybeSingle();
    if (user) {
      assignee = {
        id: user.id as string,
        name: actorName(user),
      };
    }
  }

  let completedByName: string | null = null;
  if (step.completed_by) {
    const { data: completer } = await auth.admin
      .from('users')
      .select('display_name, full_name, email')
      .eq('id', step.completed_by)
      .maybeSingle();
    if (completer) completedByName = actorName(completer);
  }

  const { data: members } = await auth.admin
    .from('deal_memberships')
    .select(
      'deal_role, user:users!deal_memberships_user_id_fkey(id, status, display_name, full_name, email)',
    )
    .eq('deal_id', dealRef.id);

  type MemberUser = {
    id?: string;
    status?: string | null;
    display_name?: string | null;
    full_name?: string | null;
    email?: string | null;
  };

  const roster =
    members?.map((row) => {
      const raw = row.user as MemberUser | MemberUser[] | null;
      const user = Array.isArray(raw) ? raw[0] : raw;
      return {
        id: user?.id ?? '',
        name: user ? actorName(user) : 'Member',
        dealRole: row.deal_role as string,
        status: user?.status ?? null,
      };
    }) ?? [];

  const { data: profile } = await auth.admin
    .from('users')
    .select('tenant_id')
    .eq('id', auth.user.id)
    .single();

  const isMd = await userIsDealMd(auth.admin, auth.user.id, dealRef.id);
  const capabilities = await resolveDealStepCapabilities(auth.admin, auth.user.id, dealRef.id, {
    assigned_to: step.assigned_to,
    status: step.status,
  });
  if (capabilities === 'unreadable') return jsonError('Profile lookup failed', 500);

  return NextResponse.json({
    step: serializeStep(step, assignee, {
      includeWork: isInternal || capabilities.canEditWork,
      completedByName,
    }),
    members: roster.filter((m) => m.id),
    permissions: {
      isMd,
      canAssign: capabilities.canAssign,
      canComplete: capabilities.canComplete,
      canEditWork: capabilities.canEditWork,
    },
    tenantId: profile?.tenant_id ?? null,
    deal: { id: dealRef.id, code: dealRef.code },
  });
}

type PatchBody = {
  assignTo?: string | null;
  benchSession?: BenchSessionPatch | null;
  work?: Record<string, unknown>;
  complete?: boolean;
  completionNote?: string;
  /**
   * A logged skip, {approverId?, reason}: the server resolves the approver
   * (#312) and writes it and the reason on the record.
   */
  skip?: unknown;
  /**
   * The step's updatedAt as the client last read it. When present the save
   * applies only if the row is still at that version, so an editor holding
   * stale work cannot re-send it over a newer save.
   */
  expectedUpdatedAt?: string;
};

/**
 * PATCH /api/v1/deals/{dealId}/steps/{stepId} — assign, save work, or complete.
 */
export async function PATCH(request: Request, context: RouteContext) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const { dealId, stepId } = await context.params;

  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return jsonError('Invalid JSON body', 400);
  }
  if (body.complete === true && body.skip !== undefined) {
    return jsonError('A step is completed or skipped, not both', 400);
  }
  if (
    body.expectedUpdatedAt !== undefined &&
    (typeof body.expectedUpdatedAt !== 'string' || Number.isNaN(Date.parse(body.expectedUpdatedAt)))
  ) {
    return jsonError('expectedUpdatedAt must be a timestamp', 400);
  }

  let dealRef;
  try {
    dealRef = await resolveDeal(auth, dealId);
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : 'Failed to resolve deal', 500);
  }
  if (!dealRef) return jsonError('Deal not found', 404);

  const allowed = await userCanAccessDeal(auth.admin, auth.user.id, dealRef.id);
  if (!allowed) return dealNotVisible();

  const step = await loadStepRow(auth.admin, dealRef.id, stepId);
  if (!step) return jsonError('Step not found for this deal', 404);
  if (step.removed_at) return jsonError('That step is not on this project rail', 409);

  const capabilities = await resolveDealStepCapabilities(auth.admin, auth.user.id, dealRef.id, {
    assigned_to: step.assigned_to,
    status: step.status,
  });
  if (capabilities === 'unreadable') return jsonError('Profile lookup failed', 500);

  const { data: deal } = await auth.admin
    .from('deals')
    .select('id, code, codename, tenant_id, mandate_owner_id, current_step_seq')
    .eq('id', dealRef.id)
    .single();
  if (!deal) return jsonError('Deal not found', 404);

  const { data: actor } = await auth.admin
    .from('users')
    .select('display_name, full_name, email')
    .eq('id', auth.user.id)
    .single();

  const actorLabel = actor ? actorName(actor) : 'Banker';
  const railStep = orderedSteps().find((s) => s.id === stepId);
  const stepTitle = railStep?.title ?? stepId;

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  // The step write, its audit rows and the rail advance commit together in
  // deal_step_save (#200): a rejected audit row rolls the step back with it.
  // Notifications go out only once that commit lands, so none of them can
  // claim a change a failed or refused update (409, #249) never made.
  const audits: Array<{ action: string; detail: Record<string, unknown> }> = [];
  const afterSave: Array<() => Promise<void>> = [];
  let advance = false;

  if (body.assignTo !== undefined) {
    if (!capabilities.canAssign) return jsonError('Not permitted to assign steps', 403);

    if (body.assignTo === null || body.assignTo === '') {
      patch.assigned_to = null;
      patch.assigned_by = null;
      patch.assigned_at = null;
    } else {
      const assigneeId = body.assignTo.trim();
      const memberOk = await userCanAccessDeal(auth.admin, assigneeId, dealRef.id);
      if (!memberOk) return jsonError('Assignee must be a member of this deal', 400);

      patch.assigned_to = assigneeId;
      patch.assigned_by = auth.user.id;
      patch.assigned_at = new Date().toISOString();

      audits.push({
        action: AUDIT_ACTION.ASSIGN_STEP,
        detail: { stepId, stepTitle, assignee: assigneeId },
      });

      if (assigneeId !== auth.user.id) {
        afterSave.push(async () => {
          await notifyStepAssigned(auth.admin, {
            tenantId: deal.tenant_id as string,
            dealId: dealRef.id,
            actorId: auth.user.id,
            assigneeId,
            dealCode: deal.code as string,
            codename: deal.codename as string,
            stepId,
            stepTitle,
            actorName: actorLabel,
          });
        });
      }
    }
  }

  if (body.benchSession !== undefined) {
    if (!capabilities.canEditWork) {
      return jsonError('Not permitted to record a draft run on this step', 403);
    }
    const resolved = benchSessionPatch(body.benchSession, step);
    if (typeof resolved.error === 'string') return jsonError(resolved.error, 400);
    Object.assign(patch, resolved);
  }

  if (body.work && typeof body.work === 'object') {
    if (!capabilities.canEditWork) {
      return jsonError('Not permitted to edit step work', 403);
    }

    // work.skip is written only by the verified skip below (#312). A client
    // value is dropped, forged or echoed: panels send back the work they read,
    // and the stored record stays through the merge.
    const work: Record<string, unknown> = { ...body.work };
    delete work.skip;
    if (Object.keys(work).length > 0) {
      patch.work = { ...(step.work ?? {}), ...work };
      audits.push({ action: AUDIT_ACTION.STEP_WORK, detail: { stepId, fields: Object.keys(work) } });
    }
  }

  if (body.complete === true) {
    if (!capabilities.canComplete) return jsonError('Not permitted to complete this step', 403);
    if (step.status === STEP_STATUS.COMPLETE) {
      return jsonError('Step is already complete', 409);
    }

    const def = manualStepDef(stepId);
    const workToValidate = (patch.work as Record<string, unknown> | undefined) ?? step.work ?? {};
    if (def) {
      const validationError = validateManualWork(def, workToValidate);
      if (validationError) return jsonError(validationError, 400);

      // The upload is the step's output on these steps, so the checklist
      // alone cannot close them. Enforced here and not only in the panel:
      // the client cannot be the gate on a compliance artifact.
      if (def.uploadRequired) {
        let hasUpload: boolean;
        try {
          hasUpload = await stepHasUpload(auth.admin, dealRef.id, stepId);
        } catch (err) {
          return jsonError(
            err instanceof Error ? err.message : 'Could not check step uploads',
            500,
          );
        }
        if (!hasUpload) {
          return jsonError(
            `${def.uploadLabel ?? 'An upload'} is required before completing this step.`,
            400,
          );
        }
      }
    }

    patch.status = STEP_STATUS.COMPLETE;
    patch.completed_by = auth.user.id;
    patch.completed_at = new Date().toISOString();
    patch.completion_note = body.completionNote?.trim() || null;

    audits.push({
      action: AUDIT_ACTION.COMPLETE_STEP,
      detail: { stepId, stepTitle, seq: step.seq },
    });
    advance = true;

    const mdId = deal.mandate_owner_id as string | null;
    if (mdId && mdId !== auth.user.id) {
      afterSave.push(async () => {
        await notifyStepCompleted(auth.admin, {
          tenantId: deal.tenant_id as string,
          dealId: dealRef.id,
          actorId: auth.user.id,
          recipientId: mdId,
          dealCode: deal.code as string,
          codename: deal.codename as string,
          stepId,
          stepTitle,
          completedBy: actorLabel,
        });
      });
    }
  }

  if (body.skip !== undefined) {
    // A logged skip closes the step like a completion does, but the record
    // says who approved it and why (Finding 5: the modal promised this was
    // logged on the deal record; it only reached localStorage).
    if (!capabilities.canComplete) return jsonError('Not permitted to skip this step', 403);
    if (
      step.status === STEP_STATUS.COMPLETE ||
      step.status === STEP_STATUS.SKIPPED ||
      step.status === STEP_STATUS.SKIPPED_ENTRY
    ) {
      return jsonError('Step is already closed', 409);
    }
    const parsed = parseStepSkip(body.skip);
    if (!parsed.ok) return jsonError(parsed.error, 400);
    // The approver is a verified seat on this deal, never the client's text (#312).
    const approver = await resolveSkipApprover(
      auth.admin,
      dealRef.id,
      auth.user.id,
      parsed.skip.approverId,
    );
    if (!approver.ok) return jsonError(approver.error, approver.status);

    const at = new Date().toISOString();
    const skipRecord = {
      approverId: approver.id,
      approver: approver.name,
      approverRole: approver.dealRole,
      reason: parsed.skip.reason,
      at,
    };
    patch.status = STEP_STATUS.SKIPPED;
    patch.completed_by = auth.user.id;
    patch.completed_at = at;
    patch.completion_note = parsed.skip.reason;
    // Explicit columns: deal_step_save re-verifies the approver and writes the
    // skip_* columns from these, so it no longer needs work.skip.approverId.
    patch.skip_approver_id = approver.id;
    patch.skip_reason = parsed.skip.reason;
    patch.work = {
      ...((patch.work as Record<string, unknown> | undefined) ?? step.work ?? {}),
      skip: skipRecord,
    };

    // The audit action list is a database CHECK; a skip is the rail advancing
    // past a step, recorded under `advance` with the skip as its detail.
    audits.push({
      action: AUDIT_ACTION.ADVANCE,
      detail: {
        kind: 'skip',
        stepId,
        stepTitle,
        seq: step.seq,
        approverId: approver.id,
        approver: approver.name,
        approverRole: approver.dealRole,
        reason: parsed.skip.reason,
      },
    });
    // The cursor is the client's to move, through /progress, as a logged skip
    // always did. Completion advances in deal_step_save instead; the rail
    // model's skip (rail_skip_step) reselects the cursor server-side.
  }

  if (Object.keys(patch).length <= 1) {
    return jsonError('No supported patch fields provided', 400);
  }

  const { data: updated, error } = await auth.admin.rpc('deal_step_save', {
    p_deal_id: dealRef.id,
    p_step_id: step.id,
    p_actor_id: auth.user.id,
    p_patch: patch,
    // Work and completion checks use the row read above: write only if nobody saved
    // the step since; otherwise a concurrent edit is silently lost (#249). The
    // client's own version, when sent, also catches an editor whose work is
    // older than the row this request read.
    p_expected_updated_at:
      body.expectedUpdatedAt ?? step.updated_at,
    p_audits: audits,
    p_advance: advance,
  });
  if (error?.code === STEP_CHANGED) {
    return jsonError('The step changed since it was read. Reload and try again.', 409);
  }
  // The seat was lost between the check above and the write (#312): the same
  // answer as the check. Any other 42501 falls through to the 500 below.
  if (isSkipApproverIneligible(error)) {
    return jsonError(SKIP_APPROVER_INELIGIBLE_ANSWER, 400);
  }
  // A skip aborted to break a lock cycle wrote nothing: a retryable 409, never the
  // database text. Other saves keep the 500 below.
  if (body.skip !== undefined && isSkipDeadlock(error)) {
    return skipRetryResponse();
  }
  if (error || !updated) {
    return auditFailed(
      error ?? { message: 'deal_step_save returned no row' },
      'The step change could not be recorded, so it did not happen. Try again.',
    );
  }

  // The step and the rail are committed: a failed notification is logged, not
  // reported as a failed save the client would retry into a 409.
  for (const effect of afterSave) {
    try {
      await effect();
    } catch (err) {
      console.error('[notify] step notification failed after commit', {
        dealId: dealRef.id,
        stepId: safeLogId(stepId),
        code: errorCodeOf(err),
      });
    }
  }

  return NextResponse.json({
    currentStepId: updated.currentStepId,
    step: serializeStep(updated.step as unknown as DealStepRow, undefined, {
      completedByName: body.complete === true || body.skip !== undefined ? actorLabel : null,
    }),
  });
}
