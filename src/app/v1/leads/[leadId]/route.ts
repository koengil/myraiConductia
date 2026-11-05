import { NextResponse } from 'next/server';

import { loadIntel } from '@/lib/conductia/intel';
import { requireConductiaLead } from '@/lib/conductia/route';
import { SCOPE } from '@/lib/conductia/scopes';

type RouteContext = { params: Promise<{ leadId: string }> };

/**
 * GET /v1/leads/{leadId} — Conductia getLead for Ignatious skill runs.
 */
export async function GET(request: Request, context: RouteContext) {
  const { leadId } = await context.params;
  const gate = await requireConductiaLead(request, leadId, SCOPE.LEAD_READ);
  if (!gate.ok) return gate.response;
  const intel = await loadIntel(gate.admin, leadId, gate.scope.tenantId);
  return NextResponse.json({
    lead: {
      ...gate.lead,
      version: intel.version,
      record: intel.fields,
    },
  });
}
