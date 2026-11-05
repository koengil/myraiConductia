import { NextResponse } from 'next/server';

import { conductiaError } from '@/lib/conductia/errors';
import {
  createPersona,
  listPersonas,
  personaReceipt,
  personaSummary,
} from '@/lib/conductia/personas';
import {
  personasVisibleToClaim,
  refuseLinkOffLead,
  requireConductiaPersonaScope,
} from '@/lib/conductia/route';
import { SCOPE } from '@/lib/conductia/scopes';

export async function GET(request: Request) {
  const gate = await requireConductiaPersonaScope(request, SCOPE.PERSONAS_READ);
  if (!gate.ok) return gate.response;
  const linkedLeadId = new URL(request.url).searchParams.get('linkedLeadId')?.trim();
  let personas;
  try {
    personas = await listPersonas(
      gate.admin,
      gate.scope.tenantId,
      gate.conductiaTenantId,
      { linkedLeadId: linkedLeadId || undefined },
    );
  } catch (error) {
    return conductiaError(
      'server_error',
      error instanceof Error ? error.message : 'Failed to list personas',
      500,
    );
  }
  // Only personas linked to the token's lead: off-lead and unlinked are left out.
  const visible = await personasVisibleToClaim(gate, personas);
  if (!visible.ok) return visible.response;
  return NextResponse.json({ personas: visible.personas.map(personaSummary) });
}

export async function POST(request: Request) {
  const gate = await requireConductiaPersonaScope(request, SCOPE.PERSONAS_WRITE);
  if (!gate.ok) return gate.response;
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return conductiaError('validation', 'Invalid JSON body', 400);
  }
  // A persona must be born linked: reads and edits are held to its links, so an
  // unlinked one would be stranded. The link writes into that lead's listing,
  // so it passes the same check as adding a link later.
  const link = body.link as { leadId?: unknown; contactId?: unknown } | undefined;
  if (!link || typeof link.leadId !== 'string' || typeof link.contactId !== 'string') {
    return conductiaError('validation', 'link with leadId and contactId is required', 400, {
      field: 'link',
    });
  }
  const offLead = await refuseLinkOffLead(gate, link.leadId);
  if (offLead) return offLead;
  try {
    const persona = await createPersona(
      gate.admin,
      gate.scope.tenantId,
      gate.conductiaTenantId,
      body,
    );
    return NextResponse.json(personaReceipt(persona, 'created'), { status: 201 });
  } catch (error) {
    return conductiaError(
      'server_error',
      error instanceof Error ? error.message : 'Failed to create persona',
      500,
    );
  }
}
