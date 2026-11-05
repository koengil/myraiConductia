import { randomUUID } from 'node:crypto';

import { recordAiUsage } from '@/lib/ai/usage';
import { jsonError } from '@/lib/api/v1/http';
import { parseBenchChatBody, streamBenchResponse, streamMeteredBenchResponse } from '@/lib/ignatious/benchRequest';
import { createSkillBench } from '@/lib/ignatious/bench';
import { leadIdForDeal } from '@/lib/ignatious/config';
import { benchScopes, mintTriggerToken } from '@/lib/ignatious/jwt';
import { ignatiousErrorResponse, requireIgnatiousDealAccess } from '@/lib/ignatious/routeContext';

type RouteContext = { params: Promise<{ dealId: string }> };

export async function POST(request: Request, context: RouteContext) {
  const { dealId } = await context.params;
  const gate = await requireIgnatiousDealAccess(dealId);
  if (!gate.ok) return gate.response;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonError('Invalid JSON body', 400);
  }
  const parsed = parseBenchChatBody(raw);
  if ('error' in parsed) return jsonError(parsed.error, 400);

  if (!gate.ctx.deal.tenantId) return jsonError('Deal has no firm', 500);
  const leadId = leadIdForDeal(gate.ctx.config, gate.ctx.deal);
  const token = mintTriggerToken({
    agentName: 'skill-bench',
    // The deal CODE, matching the wire `leadId` below. This was the deal uuid,
    // so the token's subject and the wire lead disagreed and claimBindsToLead
    // would refuse every deal-bench callback.
    dealId: leadId,
    conductiaTenantId: gate.ctx.deal.tenantId,
    scopes: benchScopes(),
    userId: gate.ctx.user.id,
    userEmail: gate.ctx.user.email,
  });

  try {
    const upstream = await createSkillBench(gate.ctx.config).chat({
      tenantId: gate.ctx.config.tenantId,
      leadId,
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

    const { admin, deal, user } = gate.ctx;
    const tenantId = deal.tenantId;
    if (!tenantId) {
      console.warn('[ai-usage] bench chat turn not metered: no firm on deal', deal.id);
      return streamBenchResponse(upstream);
    }
    return streamMeteredBenchResponse(upstream, (usage) =>
      recordAiUsage(admin, {
        tenantId,
        dealId: deal.id,
        actorId: user.id,
        source: 'bench_chat',
        // The step it was run from when the rail says so, else the bench itself.
        task: parsed.stepId ?? 'bench_chat',
        // One row per turn, keyed by the bench's per-turn run id when it sends one.
        externalId: usage.runId ?? randomUUID(),
        model: usage.model,
        costUsd: usage.costUsd,
      }),
    );
  } catch (error) {
    return ignatiousErrorResponse(error);
  }
}
