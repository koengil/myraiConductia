import { agentRunRequester, recordAiUsage } from '@/lib/ai/usage';
import { ledgerModelOf } from '@/lib/ignatious/benchMeter';
import { NextResponse } from 'next/server';

import { auditFailed, jsonError } from '@/lib/api/v1/http';
import { AUDIT_ACTION } from '@/lib/constants/audit';
import { TABLE } from '@/lib/constants/tables';
import { errorCodeOf } from '@/lib/errors/upstream';
import {
  applyPresearchToLead,
  PresearchApplyExhausted,
  PresearchApplyPending,
  PresearchApplyRetryScheduled,
  MAX_APPLY_ATTEMPTS,
} from '@/lib/ignatious/applyPresearch';
import { PRESEARCH_AGENT } from '@/lib/ignatious/config';
import { isMeetingType } from '@/lib/ignatious/control-plane';
import { mintTriggerToken, presearchScopes } from '@/lib/ignatious/jwt';
import {
  actorDisplayName,
  executionBelongsToCompany,
  ignatiousErrorResponse,
  requireIgnatiousCompany,
} from '@/lib/ignatious/routeContext';

type RouteContext = { params: Promise<{ companyId: string }> };

/**
 * POST /api/v1/companies/{companyId}/presearch — start a lead-scoped presearch.
 */
export async function POST(request: Request, context: RouteContext) {
  const { companyId } = await context.params;
  const gate = await requireIgnatiousCompany(companyId);
  if (!gate.ok) return gate.response;

  let body: { meetingType?: unknown; attendees?: unknown };
  try {
    body = (await request.json()) as { meetingType?: unknown; attendees?: unknown };
  } catch {
    return jsonError('Invalid JSON body', 400);
  }
  if (!isMeetingType(body.meetingType)) {
    return jsonError('meetingType must be first_call, closing, or working_session', 400);
  }
  const attendees = typeof body.attendees === 'string' ? body.attendees : undefined;

  const { ctx } = gate;
  const displayName = await actorDisplayName(ctx.admin, ctx.user.id);
  const token = mintTriggerToken({
    agentName: PRESEARCH_AGENT,
    dealId: ctx.company.id,
    conductiaTenantId: ctx.company.tenantId,
    scopes: presearchScopes(),
    userId: ctx.user.id,
    userEmail: ctx.user.email,
  });

  try {
    const accepted = await ctx.plane.triggerPresearch({
      tenantId: ctx.config.tenantId,
      leadId: ctx.company.id,
      token,
      requestedBy: { userId: ctx.user.id, displayName },
      inputs: { meetingType: body.meetingType, attendees },
      idempotencyKey: `presearch:${ctx.company.id}:${Date.now()}`,
    });
    const { error: auditError } = await ctx.admin.from(TABLE.AUDIT_LOG).insert({
      actor_id: ctx.user.id,
      action: AUDIT_ACTION.CREATE,
      detail: {
        kind: 'agent_run',
        agent: PRESEARCH_AGENT,
        companyId: ctx.company.id,
        executionId: accepted.executionId,
        meetingType: body.meetingType,
        ...(attendees ? { attendees } : {}),
      },
    });
    if (auditError) return auditFailed(auditError, 'The presearch run was saved, but its audit record could not be written. Contact compliance before retrying.');
    return NextResponse.json(accepted, { status: 202 });
  } catch (error) {
    return ignatiousErrorResponse(error);
  }
}

/**
 * GET /api/v1/companies/{companyId}/presearch?executionId=
 * Without executionId, returns the latest applied memo for this lead, and the
 * newest run that completed after it but is not applied yet (`pending`), so a
 * client that stopped polling resumes it.
 */
export async function GET(request: Request, context: RouteContext) {
  const { companyId } = await context.params;
  const gate = await requireIgnatiousCompany(companyId);
  if (!gate.ok) return gate.response;

  const executionId = new URL(request.url).searchParams.get('executionId')?.trim();
  if (!executionId) {
    const [latest, unapplied] = await Promise.all([
      gate.ctx.admin
        .from(TABLE.LEAD_RESEARCH)
        .select('execution_id, memo_md, people_added, created_at, agent')
        .eq('company_id', companyId)
        .not('completed_at', 'is', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      gate.ctx.admin
        .from(TABLE.LEAD_RESEARCH)
        .select('execution_id, created_at, attempts')
        .eq('company_id', companyId)
        .is('completed_at', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    const memo = latest.error ? null : (latest.data ?? null);
    const open = unapplied.error ? null : unapplied.data;
    const pending =
      open && Number(open.attempts ?? 0) < MAX_APPLY_ATTEMPTS && (!memo || String(open.created_at) > String(memo.created_at))
        ? { execution_id: String(open.execution_id) }
        : null;
    return NextResponse.json({ latest: memo, pending });
  }

  // Bind before asking the control plane. A completed run is not merely READ
  // here: applyCompletedPresearch writes its memo into this lead's research and
  // CRM people. An unbound id would let a caller graft another tenant's memo
  // onto their own lead.
  try {
    if (!(await executionBelongsToCompany(gate.ctx.admin, companyId, executionId))) {
      return jsonError('No run on this lead', 404);
    }
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : 'Run lookup failed', 500);
  }

  try {
    const status = await gate.ctx.plane.getRun(executionId);
    let apply: ApplyOutcome = { applied: null, applying: false, applyFailed: null };
    if (status.status === 'completed') {
      apply = await applyCompletedPresearch(gate.ctx, executionId, status.artifacts);
    }
    // The AI spend ledger (#109): the finished run's cost, once per execution.
    if (
      (status.status === 'completed' || status.status === 'failed' || status.status === 'cancelled') &&
      status.costUsd != null
    ) {
      const requester = await agentRunRequester(gate.ctx.admin, status.executionId);
      await recordAiUsage(gate.ctx.admin, {
        tenantId: gate.ctx.company.tenantId,
        companyId,
        // The cost belongs to whoever triggered the run, not to the poller.
        actorId: requester ?? gate.ctx.user.id,
        source: 'agent_run',
        task: 'lead_presearch',
        externalId: status.executionId,
        model: ledgerModelOf(status.modelIds),
        costUsd: status.costUsd,
      });
    }
    return NextResponse.json({ ...status, ...apply });
  } catch (error) {
    return ignatiousErrorResponse(error);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const { companyId } = await context.params;
  const gate = await requireIgnatiousCompany(companyId);
  if (!gate.ok) return gate.response;

  const executionId = new URL(request.url).searchParams.get('executionId')?.trim();
  if (!executionId) return jsonError('executionId is required', 400);

  try {
    if (!(await executionBelongsToCompany(gate.ctx.admin, companyId, executionId))) {
      return jsonError('No run on this lead', 404);
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

/**
 * Where a completed run's apply stands. `applying`: another apply holds the
 * claim, poll again. `applyFailed`: this apply failed; 'retrying' until it has
 * failed MAX_APPLY_ATTEMPTS times, then 'terminal'.
 */
type ApplyOutcome = {
  applied: { peopleAdded: number; peopleSkipped?: number; alreadyApplied: boolean } | null;
  applying: boolean;
  applyFailed: 'retrying' | 'terminal' | null;
};

async function applyCompletedPresearch(
  ctx: Extract<Awaited<ReturnType<typeof requireIgnatiousCompany>>, { ok: true }>['ctx'],
  executionId: string,
  artifacts: { path: string }[],
): Promise<ApplyOutcome> {
  const memoPath =
    artifacts.find((item) => item.path.endsWith('.md'))?.path ??
    artifacts.find((item) => item.path.includes('memo'))?.path ??
    'memo.md';
  try {
    const applied = await applyPresearchToLead({
      admin: ctx.admin,
      companyId: ctx.company.id,
      tenantId: ctx.company.tenantId,
      registeredByCompanyId: ctx.company.registeredByCompanyId,
      actorId: ctx.user.id,
      executionId,
      memo: async () => {
        const artifact = await ctx.plane.getArtifact(executionId, memoPath);
        return artifact.text();
      },
    });
    return { applied, applying: false, applyFailed: null };
  } catch (error) {
    if (error instanceof PresearchApplyPending) return { applied: null, applying: true, applyFailed: null };
    if (error instanceof PresearchApplyRetryScheduled) return { applied: null, applying: false, applyFailed: 'retrying' };
    // Artifact and apply failures are recorded on the owned claim. Claim
    // acquisition failures cannot be persisted there and are logged here.
    console.error('[presearch] apply failed', { executionId, code: errorCodeOf(error) });
    const terminal = error instanceof PresearchApplyExhausted;
    return { applied: null, applying: false, applyFailed: terminal ? 'terminal' : 'retrying' };
  }
}
