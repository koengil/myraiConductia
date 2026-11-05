import { NextResponse } from 'next/server';

import { documentRead, getLeadDocument } from '@/lib/conductia/documents';
import { conductiaError } from '@/lib/conductia/errors';
import { requireConductiaLead } from '@/lib/conductia/route';
import { SCOPE } from '@/lib/conductia/scopes';

type RouteContext = { params: Promise<{ leadId: string; documentId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const { leadId, documentId } = await context.params;
  const gate = await requireConductiaLead(request, leadId, SCOPE.DOCUMENTS_READ);
  if (!gate.ok) return gate.response;

  try {
    const stored = await getLeadDocument(gate.admin, leadId, documentId);
    if (!stored) return conductiaError('not_found', `No document ${documentId}.`, 404, { documentId });
    return NextResponse.json({
      document: documentRead(stored, gate.scope.agentName, gate.scope.runId),
    });
  } catch (error) {
    return conductiaError(
      'server_error',
      error instanceof Error ? error.message : 'Failed to load document',
      500,
    );
  }
}
