import { randomUUID } from 'node:crypto';

import { after, NextResponse } from 'next/server';

import { recordAiUsage } from '@/lib/ai/usage';
import { jsonError } from '@/lib/api/v1/http';
import { getPersona } from '@/lib/conductia/personas';
import { bareModelId } from '@/lib/ignatious/benchMeter';
import { DIGITAL_TWIN_AGENT } from '@/lib/ignatious/config';
import { digitalTwinScopes, mintTriggerToken } from '@/lib/ignatious/jwt';
import { ignatiousErrorResponse, requireIgnatiousCompany } from '@/lib/ignatious/routeContext';

import {
  TWIN_CHAT_HISTORY_MAX_CHARS,
  TWIN_CHAT_HISTORY_MAX_MESSAGES,
  TWIN_CHAT_MESSAGE_MAX_CHARS,
} from '@/lib/ignatious/twinChat';

type RouteContext = { params: Promise<{ companyId: string; personaId: string }> };

export async function POST(request: Request, context: RouteContext) {
  const { companyId, personaId } = await context.params;
  const gate = await requireIgnatiousCompany(companyId);
  if (!gate.ok) return gate.response;

  let body: { message?: unknown; history?: unknown };
  try {
    body = (await request.json()) as { message?: unknown; history?: unknown };
  } catch {
    return jsonError('Invalid JSON body', 400);
  }
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) return jsonError('message is required', 400);

  // The twin must be one of this company's, in this firm: the same set the
  // twins list shows. Anything else reads as missing, before any size check.
  let persona;
  try {
    persona = await getPersona(
      gate.ctx.admin,
      gate.ctx.config.tenantId,
      gate.ctx.company.tenantId,
      personaId,
    );
  } catch {
    return jsonError('Failed to load twin', 500);
  }
  if (!persona?.linkedContacts.some((link) => link.leadId === companyId)) {
    return jsonError('Twin not found', 404);
  }

  if (message.length > TWIN_CHAT_MESSAGE_MAX_CHARS) return jsonError('message is too long', 400);

  const history = Array.isArray(body.history)
    ? body.history
        .map((row) => {
          if (!row || typeof row !== 'object') return null;
          const rec = row as { role?: unknown; content?: unknown };
          if ((rec.role !== 'user' && rec.role !== 'assistant') || typeof rec.content !== 'string') {
            return null;
          }
          return { role: rec.role, content: rec.content };
        })
        .filter((row): row is { role: 'user' | 'assistant'; content: string } => row !== null)
    : [];
  if (
    history.length > TWIN_CHAT_HISTORY_MAX_MESSAGES ||
    history.reduce((total, row) => total + row.content.length, 0) > TWIN_CHAT_HISTORY_MAX_CHARS
  ) {
    return jsonError('history is too long', 400);
  }

  const token = mintTriggerToken({
    agentName: DIGITAL_TWIN_AGENT,
    dealId: companyId,
    conductiaTenantId: gate.ctx.company.tenantId,
    scopes: digitalTwinScopes(),
    userId: gate.ctx.user.id,
    userEmail: gate.ctx.user.email,
  });

  let reply: Awaited<ReturnType<typeof gate.ctx.plane.postTwinMessage>>;
  try {
    reply = await gate.ctx.plane.postTwinMessage({
      tenantId: gate.ctx.config.tenantId,
      leadId: companyId,
      personaId,
      message,
      history,
      token,
    });
  } catch (error) {
    return ignatiousErrorResponse(error);
  }
  // A twin turn has no id of its own: each reply is one ledger row. The
  // write runs after the response, so the ledger never slows the chat.
  const { admin, company, user } = gate.ctx;
  after(() =>
    recordAiUsage(admin, {
      tenantId: company.tenantId,
      companyId: company.id,
      actorId: user.id,
      source: 'twin_chat',
      task: 'twin_chat',
      externalId: randomUUID(),
      model: typeof reply.modelId === 'string' && reply.modelId ? bareModelId(reply.modelId) : null,
      costUsd: typeof reply.costUsd === 'number' ? reply.costUsd : null,
    }),
  );
  return NextResponse.json(reply);
}
