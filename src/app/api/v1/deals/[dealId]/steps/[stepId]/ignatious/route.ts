import { agentRunRequester, recordAiUsage } from '@/lib/ai/usage';
import { ledgerModelOf } from '@/lib/ignatious/benchMeter';
import { NextResponse } from 'next/server';

import { auditFailed, jsonError } from '@/lib/api/v1/http';
import { AUDIT_ACTION } from '@/lib/constants/audit';
import { TABLE } from '@/lib/constants/tables';
import {
  actorDisplayName,
  executionBelongsToDeal,
  ignatiousErrorResponse,
  requireIgnatiousDeal,
  type IgnatiousRouteAuth,
} from '@/lib/ignatious/routeContext';
import { leadIdForDeal } from '@/lib/ignatious/config';
import { isBriefDepth, isMeetingType } from '@/lib/ignatious/control-plane';
import { mdBriefingScopes, mintTriggerToken } from '@/lib/ignatious/jwt';
import { MD_BRIEFING_AGENT } from '@/lib/ignatious/config';
import { dbFailure } from '@/lib/errors/upstream';

type RouteContext = { params: Promise<{ dealId: string; stepId: string }> };

type TriggerBody = {
  meetingType?: unknown;
  depth?: unknown;
  attendees?: unknown;
};

/**
 * POST /api/v1/deals/{dealId}/steps/{stepId}/ignatious — start md-briefing.
 */
export async function POST(request: Request, context: RouteContext) {
  const { dealId, stepId } = await context.params;
  const gate = await requireIgnatiousDeal(dealId, stepId);
  if (!gate.ok) return gate.response;

  let body: TriggerBody;
  try {
    body = (await request.json()) as TriggerBody;
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  if (!isMeetingType(body.meetingType)) {
    return jsonError('meetingType must be first_call, closing, or working_session', 400);
  }
  if (!isBriefDepth(body.depth)) {
    return jsonError('depth must be one_pager or full_memo', 400);
  }
  const attendees = typeof body.attendees === 'string' ? body.attendees : undefined;

  const { ctx } = gate;
  // Fail closed: the tenant claim is what the callback's lead boundary trusts,
  // so a deal with no tenant must not get a token rather than an unscoped one.
  if (!ctx.deal.tenantId) return jsonError('Deal has no firm', 500);
  const leadId = leadIdForDeal(ctx.config, ctx.deal);
  const displayName = await actorDisplayName(ctx.admin, ctx.user.id);
  const token = mintTriggerToken({
    agentName: MD_BRIEFING_AGENT,
    dealId: leadId,
    conductiaTenantId: ctx.deal.tenantId,
    scopes: mdBriefingScopes(),
    userId: ctx.user.id,
    userEmail: ctx.user.email,
  });

  try {
    const accepted = await ctx.plane.triggerMdBriefing({
      tenantId: ctx.config.tenantId,
      leadId,
      token,
      requestedBy: { userId: ctx.user.id, displayName },
      inputs: { meetingType: body.meetingType, depth: body.depth, attendees },
      idempotencyKey: `md-brief:${ctx.deal.id}:${Date.now()}`,
    });
    const { error: auditError } = await ctx.admin.from(TABLE.AUDIT_LOG).insert({
      actor_id: ctx.user.id,
      action: AUDIT_ACTION.CREATE,
      deal_id: ctx.deal.id,
      detail: {
        kind: 'agent_run',
        agent: MD_BRIEFING_AGENT,
        stepId,
        executionId: accepted.executionId,
        runId: accepted.runId,
        meetingType: body.meetingType,
        depth: body.depth,
        ...(attendees ? { attendees } : {}),
      },
    });
    if (auditError) return auditFailed(auditError, 'The briefing run was saved, but its audit record could not be written. Contact compliance before retrying.');
    return NextResponse.json(accepted, { status: 202 });
  } catch (error) {
    return ignatiousErrorResponse(error);
  }
}

/**
 * GET /api/v1/deals/{dealId}/steps/{stepId}/ignatious?executionId=
 */
export async function GET(request: Request, context: RouteContext) {
  const { dealId, stepId } = await context.params;
  const gate = await requireIgnatiousDeal(dealId, stepId);
  if (!gate.ok) return gate.response;

  const params = new URL(request.url).searchParams;
  let executionId = params.get('executionId')?.trim();
  if (!executionId && params.get('latest') === '1') {
    // The newest run triggered on this step, from the trigger's audit row
    // (Finding 3: a run paused on questions was lost once the panel unmounted;
    // the run itself never was, only the browser's handle on it).
    let found: string | null;
    try {
      found = await latestExecutionId(gate.ctx.admin, gate.ctx.deal.id, stepId, gate.ctx.user.id);
    } catch (error) {
      return jsonError(error instanceof Error ? error.message : 'Run lookup failed', 500);
    }
    if (!found) return jsonError('No run on this step', 404);
    executionId = found;
  } else if (executionId) {
    // An explicit id is caller-supplied; bind it to this deal before asking the
    // control plane about it. The `latest=1` branch above resolved its own id
    // from this deal's audit rows, so it is bound by construction.
    try {
      if (!(await executionBelongsToDeal(gate.ctx.admin, gate.ctx.deal.id, executionId))) {
        return jsonError('No run on this step', 404);
      }
    } catch (error) {
      return jsonError(error instanceof Error ? error.message : 'Run lookup failed', 500);
    }
  }
  if (!executionId) return jsonError('executionId is required', 400);

  try {
    const status = await gate.ctx.plane.getRun(executionId);
    // The AI spend ledger (#109): a finished run's cost, once (the ledger is
    // keyed by execution id, so every later poll is a no-op).
    if (RUN_DONE.has(status.status) && status.costUsd != null && gate.ctx.deal.tenantId) {
      const requester = await agentRunRequester(gate.ctx.admin, status.executionId);
      await recordAiUsage(gate.ctx.admin, {
        tenantId: gate.ctx.deal.tenantId,
        dealId: gate.ctx.deal.id,
        // The cost belongs to whoever triggered the run, not to the poller.
        actorId: requester ?? gate.ctx.user.id,
        source: 'agent_run',
        task: stepId,
        externalId: status.executionId,
        model: ledgerModelOf(status.modelIds),
        costUsd: status.costUsd,
      });
    }
    return NextResponse.json(status);
  } catch (error) {
    return ignatiousErrorResponse(error);
  }
}

const RUN_DONE: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);

/**
 * The executionId of the most recent `agent_run` audit row this actor wrote
 * on this step. Scoped to the actor: another member's run is theirs, and its
 * questions carry their brief context. Throws on a query error so a broken
 * lookup is a 500, never a silent "no run".
 */
export async function latestExecutionId(
  admin: Pick<IgnatiousRouteAuth['admin'], 'from'>,
  dealId: string,
  stepId: string,
  actorId: string,
): Promise<string | null> {
  const { data, error } = await admin
    .from(TABLE.AUDIT_LOG)
    .select('detail')
    .eq('deal_id', dealId)
    .eq('actor_id', actorId)
    .eq('action', AUDIT_ACTION.CREATE)
    .contains('detail', { kind: 'agent_run', stepId })
    // audit_log stamps `ts`, not `created_at` (permissions_schema migration).
    .order('ts', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw dbFailure('Agent run lookup', error);
  const detail = (data?.detail ?? null) as { executionId?: unknown } | null;
  return typeof detail?.executionId === 'string' && detail.executionId ? detail.executionId : null;
}

/**
 * DELETE /api/v1/deals/{dealId}/steps/{stepId}/ignatious?executionId= — cancel.
 */
export async function DELETE(request: Request, context: RouteContext) {
  const { dealId, stepId } = await context.params;
  const gate = await requireIgnatiousDeal(dealId, stepId);
  if (!gate.ok) return gate.response;

  const executionId = new URL(request.url).searchParams.get('executionId')?.trim();
  if (!executionId) return jsonError('executionId is required', 400);

  try {
    if (!(await executionBelongsToDeal(gate.ctx.admin, gate.ctx.deal.id, executionId))) {
      return jsonError('No run on this step', 404);
    }
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : 'Run lookup failed', 500);
  }

  try {
    const cancelled = await gate.ctx.plane.cancelRun(executionId);
    return NextResponse.json(cancelled);
  } catch (error) {
    return ignatiousErrorResponse(error);
  }
}
