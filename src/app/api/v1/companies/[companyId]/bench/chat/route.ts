import { randomUUID } from 'node:crypto';

import { recordAiUsage } from '@/lib/ai/usage';
import { jsonError } from '@/lib/api/v1/http';
import { parseBenchChatBody, streamMeteredBenchResponse } from '@/lib/ignatious/benchRequest';
import { createSkillBench } from '@/lib/ignatious/bench';
import { benchScopes, mintTriggerToken } from '@/lib/ignatious/jwt';
import { ignatiousErrorResponse, requireIgnatiousCompany } from '@/lib/ignatious/routeContext';

type RouteContext = { params: Promise<{ companyId: string }> };

export async function POST(request: Request, context: RouteContext) {
  const { companyId } = await context.params;
  const gate = await requireIgnatiousCompany(companyId);
  if (!gate.ok) return gate.response;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonError('Invalid JSON body', 400);
  }
  const parsed = parseBenchChatBody(raw);
  if ('error' in parsed) return jsonError(parsed.error, 400);

  const token = mintTriggerToken({
    agentName: 'skill-bench',
    dealId: companyId,
    conductiaTenantId: gate.ctx.company.tenantId,
    scopes: benchScopes(),
    userId: gate.ctx.user.id,
    userEmail: gate.ctx.user.email,
  });

  try {
    const upstream = await createSkillBench(gate.ctx.config).chat({
      tenantId: gate.ctx.config.tenantId,
      leadId: companyId,
      message: parsed.message,
      conversationId: parsed.conversationId,
      selection: parsed.selection,
      model: parsed.model,
      token,
    });

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text();
      return new Response(text || `Skill bench answered ${upstream.status}`, {
        status: upstream.status >= 400 ? upstream.status : 502,
        headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
      });
    }

    const { admin, company, user } = gate.ctx;
    return streamMeteredBenchResponse(upstream, (usage) =>
      recordAiUsage(admin, {
        tenantId: company.tenantId,
        companyId: company.id,
        actorId: user.id,
        source: 'bench_chat',
        task: 'bench_chat',
        externalId: usage.runId ?? randomUUID(),
        model: usage.model,
        costUsd: usage.costUsd,
      }),
    );
  } catch (error) {
    return ignatiousErrorResponse(error);
  }
}
