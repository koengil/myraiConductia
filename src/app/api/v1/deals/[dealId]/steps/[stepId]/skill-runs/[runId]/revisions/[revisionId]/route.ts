import { NextResponse } from 'next/server';

import { isUuid, jsonError } from '@/lib/api/v1/http';
import { requireRevisionAccess } from '@/lib/skillRun/revisionAccess';
import { loadChain } from '@/lib/skillRun/revisionStore';

type RouteContext = {
  params: Promise<{ dealId: string; stepId: string; runId: string; revisionId: string }>;
};

export async function GET(_request: Request, context: RouteContext) {
  const { dealId, stepId, runId, revisionId } = await context.params;
  const access = await requireRevisionAccess(dealId, stepId, 'read');
  if (!access.ok) return access.response;
  if (!isUuid(runId) || !isUuid(revisionId)) return jsonError('Version not found', 404);

  const loaded = await loadChain(access.ctx.admin, access.ctx.step.dealStepId, runId);
  if (loaded === 'unreadable') return jsonError('The version could not be read', 500);
  const version = loaded?.chain.versions.find((entry) => entry.id === revisionId);
  if (!version) return jsonError('Version not found', 404);
  return NextResponse.json({ id: version.id, text: version.text });
}
