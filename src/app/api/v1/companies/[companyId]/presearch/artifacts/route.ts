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
  executionBelongsToCompany,
  ignatiousErrorResponse,
  requireIgnatiousCompany,
} from '@/lib/ignatious/routeContext';

type RouteContext = { params: Promise<{ companyId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const { companyId } = await context.params;
  const gate = await requireIgnatiousCompany(companyId);
  if (!gate.ok) return gate.response;

  // GET ...?executionId=&artifact=<index>: the artifact is named by its index in
  // the run, and the path is resolved from the run here, never read from the URL (#331).
  const url = new URL(request.url);
  if (url.searchParams.has('path')) return jsonError(ARTIFACT_PATH_REFUSED, 400);
  const executionId = url.searchParams.get('executionId')?.trim();
  const index = parseArtifactIndex(url.searchParams.get('artifact'));
  if (!executionId || index === null) return jsonError(ARTIFACT_REF_REQUIRED, 400);

  try {
    if (!(await executionBelongsToCompany(gate.ctx.admin, companyId, executionId))) {
      return jsonError('No run on this lead', 404);
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
