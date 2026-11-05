import { NextResponse } from 'next/server';

import { conductiaError } from '@/lib/conductia/errors';
import { linkPersona, personaReceipt } from '@/lib/conductia/personas';
import {
  loadPersonaForWrite,
  refuseLinkOffLead,
  requireConductiaPersonaScope,
} from '@/lib/conductia/route';
import { SCOPE } from '@/lib/conductia/scopes';

type RouteContext = { params: Promise<{ personaId: string }> };

export async function POST(request: Request, context: RouteContext) {
  const { personaId } = await context.params;
  const gate = await requireConductiaPersonaScope(request, SCOPE.PERSONAS_WRITE);
  if (!gate.ok) return gate.response;

  let body: { link?: { tenantId?: string; leadId?: string; contactId?: string } };
  try {
    body = (await request.json()) as { link?: { tenantId?: string; leadId?: string; contactId?: string } };
  } catch {
    return conductiaError('validation', 'Invalid JSON body', 400);
  }
  const link = body.link;
  // link.tenantId is still accepted for wire compatibility but IGNORED: the
  // tenant is stamped from the verified scope. Honouring it would let a caller
  // file a persona under any tenant they named.
  if (!link?.leadId || !link.contactId) {
    return conductiaError('validation', 'link.leadId and contactId are required', 400);
  }

  const offLead = await refuseLinkOffLead(gate, link.leadId);
  if (offLead) return offLead;
  // And the persona itself must be writable by this run: adding its own lead
  // to another lead's persona would otherwise unlock every later write.
  const checked = await loadPersonaForWrite(gate, personaId, { allowUnlinked: true });
  if (!checked.ok) return checked.response;

  try {
    const persona = await linkPersona(
      gate.admin,
      gate.scope.tenantId,
      gate.conductiaTenantId,
      personaId,
      checked.persona.version,
      { leadId: link.leadId, contactId: link.contactId },
    );
    if (!persona) return conductiaError('not_found', `No persona ${personaId}.`, 404, { personaId });
    return NextResponse.json(personaReceipt(persona, 'linked'));
  } catch (error) {
    if (error instanceof Error && error.name === 'VersionConflict') {
      return conductiaError('version_conflict', error.message, 409);
    }
    return conductiaError('server_error', 'Failed to link persona', 500);
  }
}
