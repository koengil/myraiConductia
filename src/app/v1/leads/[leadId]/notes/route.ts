import { NextResponse } from 'next/server';

import { addNote } from '@/lib/conductia/intel';
import { conductiaError } from '@/lib/conductia/errors';
import { requireConductiaLead } from '@/lib/conductia/route';
import { SCOPE } from '@/lib/conductia/scopes';

type RouteContext = { params: Promise<{ leadId: string }> };

export async function POST(request: Request, context: RouteContext) {
  const { leadId } = await context.params;
  const gate = await requireConductiaLead(request, leadId, SCOPE.NOTES_WRITE);
  if (!gate.ok) return gate.response;

  let body: { title?: unknown; body?: unknown; topic?: unknown };
  try {
    body = (await request.json()) as { title?: unknown; body?: unknown; topic?: unknown };
  } catch {
    return conductiaError('validation', 'Invalid JSON body', 400);
  }
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const noteBody = typeof body.body === 'string' ? body.body.trim() : '';
  if (title.length < 4 || noteBody.length < 8) {
    return conductiaError('validation', 'title and body are required', 400);
  }
  const receipt = await addNote(gate.admin, leadId, gate.scope.tenantId, {
    title,
    body: noteBody,
    topic: body.topic,
  });
  return NextResponse.json({ ...receipt, outcome: 'created' });
}
