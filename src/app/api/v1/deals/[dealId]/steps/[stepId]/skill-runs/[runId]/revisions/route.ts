import { randomUUID } from 'node:crypto';

import { after, NextResponse } from 'next/server';

import { auditFailed, isUuid, jsonError } from '@/lib/api/v1/http';
import { TABLE } from '@/lib/constants/tables';
import { readIgnatiousConfig } from '@/lib/ignatious/config';
import { SKILL_SERVICE_UNCONFIGURED_MESSAGE } from '@/lib/ignatious/failure';
import {
  applyCommentBatch,
  auditRevisionStarted,
  handEditsProblem,
  HEAD_MOVED_MESSAGE,
  recordHandRevision,
  recordRestore,
  type RevisionResult,
  type RevisionTarget,
} from '@/lib/skillRun/applyRevision';
import { requireRevisionAccess } from '@/lib/skillRun/revisionAccess';
import { loadChain } from '@/lib/skillRun/revisionStore';
import { parseRevisionRequest, validateEdits } from '@/lib/skillRun/revisions';

export const maxDuration = 300;

type RouteContext = { params: Promise<{ dealId: string; stepId: string; runId: string }> };

function respond(result: RevisionResult): NextResponse {
  if (!result.ok) return jsonError(result.message, result.status);
  return NextResponse.json({ revisionId: result.revisionId }, { status: 201 });
}

export async function POST(request: Request, context: RouteContext) {
  const { dealId, stepId, runId } = await context.params;
  const access = await requireRevisionAccess(dealId, stepId, 'write');
  if (!access.ok) return access.response;
  const { ctx } = access;
  if (!isUuid(runId)) return jsonError('Run not found', 404);

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonError('Invalid JSON body', 400);
  }
  const parsed = parseRevisionRequest(raw);
  if ('error' in parsed) return jsonError(parsed.error, 422);

  const loaded = await loadChain(ctx.admin, ctx.step.dealStepId, runId);
  if (loaded === 'unreadable') return jsonError('The run could not be read', 500);
  if (!loaded) return jsonError('Run not found', 404);
  const { root, chain } = loaded;
  if (chain.headText === null) return jsonError('Only a run that succeeded can be revised', 409);
  if (parsed.parentId !== chain.headId) return jsonError(HEAD_MOVED_MESSAGE, 409);

  const target: RevisionTarget = {
    admin: ctx.admin,
    dealId: ctx.deal.id,
    stepKey: ctx.step.stepKey,
    stepTitle: ctx.step.title,
    actorId: ctx.user.id,
    root,
    parent: { id: chain.headId, text: chain.headText },
  };

  if (parsed.kind === 'restore') {
    const version = chain.versions.find((entry) => entry.id === parsed.restoreOf);
    if (!version) return jsonError('That version is not part of this run', 404);
    if (version.id === chain.headId) return jsonError('That version is already the current one', 422);
    return respond(await recordRestore(target, version));
  }

  const problem = validateEdits(chain.headText, parsed.edits);
  if (problem) return jsonError(problem, 422);

  if (parsed.edits.every((edit) => edit.kind === 'hand')) {
    return respond(await recordHandRevision(target, parsed.edits));
  }

  if (parsed.edits.some((edit) => edit.kind === 'hand')) {
    const handProblem = handEditsProblem(chain.headText, parsed.edits);
    if (handProblem) return jsonError(handProblem, 422);
  }

  const config = readIgnatiousConfig();
  if (!config) return jsonError(SKILL_SERVICE_UNCONFIGURED_MESSAGE, 503);

  const { data: owner, error: ownerError } = await ctx.admin
    .from(TABLE.DEALS)
    .select('tenant_id')
    .eq('id', ctx.deal.id)
    .maybeSingle();
  if (ownerError) return jsonError('Deal lookup failed', 500);
  const tenantId = (owner?.tenant_id as string | null | undefined) ?? null;
  if (!tenantId) return jsonError('Deal has no firm', 500);

  const revisionId = randomUUID();
  const auditError = await auditRevisionStarted(target, revisionId, parsed.edits);
  if (auditError) {
    return auditFailed(auditError, 'The edit could not be recorded, so it was not started. Try again.');
  }

  after(() =>
    applyCommentBatch({
      ...target,
      revisionId,
      edits: parsed.edits,
      tenantId,
      deal: ctx.deal,
      config,
      actorEmail: ctx.user.email,
    }),
  );
  return NextResponse.json({ revisionId }, { status: 202 });
}
