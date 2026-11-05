import { NextResponse } from 'next/server';

import { addTask, loadIntel } from '@/lib/conductia/intel';
import { conductiaError } from '@/lib/conductia/errors';
import { requireConductiaLead } from '@/lib/conductia/route';
import { SCOPE } from '@/lib/conductia/scopes';

type RouteContext = { params: Promise<{ leadId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const { leadId } = await context.params;
  const gate = await requireConductiaLead(request, leadId, SCOPE.LEAD_READ);
  if (!gate.ok) return gate.response;
  const intel = await loadIntel(gate.admin, leadId, gate.scope.tenantId);
  return NextResponse.json({ tasks: intel.tasks });
}

export async function POST(request: Request, context: RouteContext) {
  const { leadId } = await context.params;
  const gate = await requireConductiaLead(request, leadId, SCOPE.TASKS_WRITE);
  if (!gate.ok) return gate.response;

  let body: { task?: Record<string, unknown> };
  try {
    body = (await request.json()) as { task?: Record<string, unknown> };
  } catch {
    return conductiaError('validation', 'Invalid JSON body', 400);
  }
  const task = body.task ?? {};
  const receipt = await addTask(gate.admin, leadId, gate.scope.tenantId, {
    ...task,
    proposedByRunId: gate.scope.runId,
    agentName: gate.scope.agentName,
  });
  return NextResponse.json(receipt);
}
