import { NextResponse } from 'next/server';

import { jsonError } from '@/lib/api/v1/http';
import {
  actorDisplayName,
  executionBelongsToCompany,
  ignatiousErrorResponse,
  requireIgnatiousCompany,
} from '@/lib/ignatious/routeContext';

type RouteContext = { params: Promise<{ companyId: string }> };

export async function POST(request: Request, context: RouteContext) {
  const { companyId } = await context.params;
  const gate = await requireIgnatiousCompany(companyId);
  if (!gate.ok) return gate.response;

  let body: { executionId?: unknown; answers?: unknown; timedOut?: unknown };
  try {
    body = (await request.json()) as { executionId?: unknown; answers?: unknown };
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  const executionId = typeof body.executionId === 'string' ? body.executionId.trim() : '';
  if (!executionId) return jsonError('executionId is required', 400);

  const answers = Array.isArray(body.answers)
    ? body.answers
        .map((row) => {
          if (!row || typeof row !== 'object') return null;
          const rec = row as { questionId?: unknown; answer?: unknown };
          if (typeof rec.questionId !== 'string' || typeof rec.answer !== 'string') return null;
          const questionId = rec.questionId.trim();
          const answer = rec.answer.trim();
          if (!questionId || !answer) return null;
          return { questionId, answer };
        })
        .filter((row): row is { questionId: string; answer: string } => row !== null)
    : [];

  // Answers are injected INTO the run, so an unbound id would feed another
  // tenant's paused run.
  try {
    if (!(await executionBelongsToCompany(gate.ctx.admin, companyId, executionId))) {
      return jsonError('No run on this lead', 404);
    }
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : 'Run lookup failed', 500);
  }

  const displayName = await actorDisplayName(gate.ctx.admin, gate.ctx.user.id);
  try {
    const accepted = await gate.ctx.plane.answerRun(executionId, {
      userId: gate.ctx.user.id,
      displayName,
      answers,
      timedOut: body.timedOut === true,
    });
    return NextResponse.json(accepted, { status: 202 });
  } catch (error) {
    return ignatiousErrorResponse(error);
  }
}
