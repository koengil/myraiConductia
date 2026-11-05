import { NextResponse } from 'next/server';

import { listPersonas, personaSummary } from '@/lib/conductia/personas';
import { ignatiousErrorResponse, requireIgnatiousCompany } from '@/lib/ignatious/routeContext';

type RouteContext = { params: Promise<{ companyId: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const { companyId } = await context.params;
  const gate = await requireIgnatiousCompany(companyId);
  if (!gate.ok) return gate.response;

  try {
    // Scoped by the company's own tenant, not config.tenantId. That is the
    // Ignatious handle, one constant for the whole deployment, so scoping a DB
    // read by it is no scoping at all.
    //
    // The previous unlinked fallback -- list EVERY persona in the partition
    // when none was linked to this company -- is gone with it: under the shared
    // handle it surfaced every firm's twins on this lead's page.
    const personas = await listPersonas(
      gate.ctx.admin,
      gate.ctx.config.tenantId,
      gate.ctx.company.tenantId,
      { linkedLeadId: companyId },
    );
    return NextResponse.json({ personas: personas.map(personaSummary) });
  } catch (error) {
    return ignatiousErrorResponse(error);
  }
}
