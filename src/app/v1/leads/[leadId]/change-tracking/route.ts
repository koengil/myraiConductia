import { NextResponse } from 'next/server';

import { requireConductiaLead } from '@/lib/conductia/route';
import { SCOPE } from '@/lib/conductia/scopes';

type RouteContext = { params: Promise<{ leadId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const { leadId } = await context.params;
  const gate = await requireConductiaLead(request, leadId, SCOPE.LEAD_READ);
  if (!gate.ok) return gate.response;
  return NextResponse.json({
    changeTracking: {
      available: false,
      omittedPaths: [],
      authorities: [],
      recentChanges: [],
      historyDepth: null,
      retrievedAt: null,
      unavailableReason: 'Intellibank does not expose change tracking on this seam.',
    },
  });
}
