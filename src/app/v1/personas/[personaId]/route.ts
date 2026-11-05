import { NextResponse } from 'next/server';

import { conductiaError } from '@/lib/conductia/errors';
import { getPersona, personaRead, personaReceipt, updatePersona } from '@/lib/conductia/personas';
import {
  loadPersonaForWrite,
  personasVisibleToClaim,
  requireConductiaPersonaScope,
} from '@/lib/conductia/route';
import { SCOPE } from '@/lib/conductia/scopes';

type RouteContext = { params: Promise<{ personaId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const { personaId } = await context.params;
  const gate = await requireConductiaPersonaScope(request, SCOPE.PERSONAS_READ);
  if (!gate.ok) return gate.response;
  const notFound = () => conductiaError('not_found', `No persona ${personaId}.`, 404, { personaId });
  let persona;
  try {
    persona = await getPersona(gate.admin, gate.scope.tenantId, gate.conductiaTenantId, personaId);
  } catch {
    return conductiaError('server_error', 'Failed to load persona', 500);
  }
  if (!persona) return notFound();
  // Off-lead and unlinked answer the missing 404, so a read cannot probe which
  // personas exist.
  const visible = await personasVisibleToClaim(gate, [persona]);
  if (!visible.ok) return visible.response;
  if (visible.personas.length === 0) return notFound();
  return NextResponse.json(personaRead(persona));
}

export async function PATCH(request: Request, context: RouteContext) {
  const { personaId } = await context.params;
  const gate = await requireConductiaPersonaScope(request, SCOPE.PERSONAS_WRITE);
  if (!gate.ok) return gate.response;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return conductiaError('validation', 'Invalid JSON body', 400);
  }
  if (typeof body.ifVersion !== 'number') {
    return conductiaError('validation', 'ifVersion is required', 400);
  }

  // A linked persona is written only by a run on one of its leads. The update
  // lands only on the version authorized here, so a link racing in between
  // misses as a version conflict.
  const checked = await loadPersonaForWrite(gate, personaId);
  if (!checked.ok) return checked.response;
  if (checked.persona.version !== body.ifVersion) {
    return conductiaError(
      'version_conflict',
      `expected ${body.ifVersion}, current ${checked.persona.version}`,
      409,
    );
  }

  try {
    const persona = await updatePersona(
      gate.admin,
      gate.scope.tenantId,
      gate.conductiaTenantId,
      personaId,
      body.ifVersion,
      (body.patch as Record<string, unknown>) ?? {},
      {
        evidence: Array.isArray(body.evidence) ? body.evidence : [],
        noChangeRationale: typeof body.noChangeRationale === 'string' ? body.noChangeRationale : null,
        changeSummary: typeof body.changeSummary === 'string' ? body.changeSummary : null,
      },
    );
    return NextResponse.json(personaReceipt(persona, 'updated'));
  } catch (error) {
    if (error instanceof Error && error.name === 'VersionConflict') {
      return conductiaError('version_conflict', error.message, 409);
    }
    if (error instanceof Error && error.message === 'Persona not found') {
      return conductiaError('not_found', error.message, 404, { personaId });
    }
    return conductiaError(
      'server_error',
      error instanceof Error ? error.message : 'Failed to update persona',
      500,
    );
  }
}
