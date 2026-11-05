import { NextResponse } from 'next/server';

import { conductiaError } from '@/lib/conductia/errors';
import { applyLeadFieldsPatch, VersionConflict, writeReceipt } from '@/lib/conductia/intel';
import { requireConductiaLead } from '@/lib/conductia/route';
import { SCOPE } from '@/lib/conductia/scopes';

type RouteContext = { params: Promise<{ leadId: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  const { leadId } = await context.params;
  const gate = await requireConductiaLead(request, leadId, SCOPE.LEAD_WRITE);
  if (!gate.ok) return gate.response;

  let body: { ifVersion?: unknown; patch?: unknown };
  try {
    body = (await request.json()) as { ifVersion?: unknown; patch?: unknown };
  } catch {
    return conductiaError('validation', 'Invalid JSON body', 400);
  }
  if (typeof body.ifVersion !== 'number' || !body.patch || typeof body.patch !== 'object') {
    return conductiaError('validation', 'ifVersion and patch are required', 400);
  }

  try {
    const { state } = await applyLeadFieldsPatch(
      gate.admin,
      leadId,
      gate.scope.tenantId,
      body.ifVersion,
      body.patch as Record<string, unknown>,
    );
    return NextResponse.json(writeReceipt('lead', state.version, []));
  } catch (error) {
    if (error instanceof VersionConflict) {
      return conductiaError('version_conflict', error.message, 409, {
        expectedVersion: error.expected,
        actualVersion: error.actual,
      });
    }
    return conductiaError(
      'server_error',
      error instanceof Error ? error.message : 'Failed to write lead fields',
      500,
    );
  }
}
