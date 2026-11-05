import { NextResponse } from 'next/server';

import { jsonError } from '@/lib/api/v1/http';
import { artifactHeaders } from '@/lib/ignatious/artifactHeaders';
import {
  ARTIFACT_PATH_REFUSED,
  ARTIFACT_REF_REQUIRED,
  parseArtifactIndex,
  resolveArtifactPath,
} from '@/lib/ignatious/artifactRef';
import {
  executionBelongsToDeal,
  ignatiousErrorResponse,
  requireIgnatiousDeal,
} from '@/lib/ignatious/routeContext';

type RouteContext = { params: Promise<{ dealId: string; stepId: string }> };

/**
 * GET /api/v1/deals/{dealId}/steps/{stepId}/ignatious/artifacts?executionId=&artifact=<index>
 * Proxies one run artifact, addressed by its index in the run's artifact list.
 * The path is resolved here from the run, never read from the URL (#331). The
 * inbound key stays on the server.
 */
export async function GET(request: Request, context: RouteContext) {
  const { dealId, stepId } = await context.params;
  const gate = await requireIgnatiousDeal(dealId, stepId);
  if (!gate.ok) return gate.response;

  const url = new URL(request.url);
  if (url.searchParams.has('path')) return jsonError(ARTIFACT_PATH_REFUSED, 400);
  const executionId = url.searchParams.get('executionId')?.trim();
  const index = parseArtifactIndex(url.searchParams.get('artifact'));
  if (!executionId || index === null) return jsonError(ARTIFACT_REF_REQUIRED, 400);

  try {
    if (!(await executionBelongsToDeal(gate.ctx.admin, gate.ctx.deal.id, executionId))) {
      return jsonError('No run on this step', 404);
    }
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : 'Run lookup failed', 500);
  }

  try {
    const path = await resolveArtifactPath(gate.ctx.plane, executionId, index);
    if (!path) return jsonError('No such artifact on this run', 404);
    if (path.includes('..')) return jsonError('Invalid artifact path', 400);
    const upstream = await gate.ctx.plane.getArtifact(executionId, path);
    return new NextResponse(upstream.body, {
      status: 200,
      headers: artifactHeaders(upstream.headers, { filename: path.split('/').pop() }),
    });
  } catch (error) {
    return ignatiousErrorResponse(error);
  }
}
