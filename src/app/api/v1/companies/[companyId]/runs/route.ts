import { NextResponse } from 'next/server';

import { jsonError } from '@/lib/api/v1/http';
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
    const status = await gate.ctx.plane.getRun(executionId);
    return NextResponse.json(status);
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
    return NextResponse.json(await gate.ctx.plane.cancelRun(executionId));
  } catch (error) {
    return ignatiousErrorResponse(error);
  }
}
