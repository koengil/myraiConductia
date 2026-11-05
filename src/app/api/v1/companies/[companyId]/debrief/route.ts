import { NextResponse } from 'next/server';

import { auditFailed, jsonError } from '@/lib/api/v1/http';
import { AUDIT_ACTION } from '@/lib/constants/audit';
import { persistLeadDocument } from '@/lib/conductia/documents';
import {
  DIGITAL_TWIN_BUILDER_AGENT,
  SOURCE_INTELLIGENCE_AGENT,
} from '@/lib/ignatious/config';
import { digitalTwinScopes, mintTriggerToken, sourceIntelligenceScopes } from '@/lib/ignatious/jwt';
import {
  actorDisplayName,
  ignatiousErrorResponse,
  requireIgnatiousCompany,
} from '@/lib/ignatious/routeContext';

type RouteContext = { params: Promise<{ companyId: string }> };

/**
 * POST /api/v1/companies/{companyId}/debrief
 * File a source debrief and start source-intelligence + digital-twin-builder.
 */
export async function POST(request: Request, context: RouteContext) {
  const { companyId } = await context.params;
  const gate = await requireIgnatiousCompany(companyId);
  if (!gate.ok) return gate.response;

  let body: { title?: unknown; text?: unknown; runTwins?: unknown };
  try {
    body = (await request.json()) as { title?: unknown; text?: unknown; runTwins?: unknown };
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (text.length < 40) {
    return jsonError('Paste at least a short debrief (40+ characters) so the agents have something to read.', 400);
  }
  const title =
    typeof body.title === 'string' && body.title.trim() ? body.title.trim() : 'Lead partner debrief';
  const runTwins = body.runTwins !== false;

  const { ctx } = gate;
  const displayName = await actorDisplayName(ctx.admin, ctx.user.id);
  const leadId = ctx.company.id;

  let document;
  try {
    document = await persistLeadDocument(ctx.admin, {
      tenantId: ctx.config.tenantId,
      leadId,
      title,
      documentType: 'lead_partner_debrief',
      folder: 'source-materials',
      kind: 'meeting_notes',
      text,
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : 'Failed to store the debrief', 500);
  }

  const requestedBy = { userId: ctx.user.id, displayName };

  try {
    const sourceToken = mintTriggerToken({
      agentName: SOURCE_INTELLIGENCE_AGENT,
      dealId: leadId,
      conductiaTenantId: ctx.company.tenantId,
      scopes: sourceIntelligenceScopes(),
      userId: ctx.user.id,
      userEmail: ctx.user.email,
    });
    const sourceRun = await ctx.plane.triggerSkill({
      agentName: SOURCE_INTELLIGENCE_AGENT,
      tenantId: ctx.config.tenantId,
      leadId,
      token: sourceToken,
      requestedBy,
      triggerType: 'document_uploaded',
      documentId: document.documentId,
      idempotencyKey: `si:${leadId}:${document.documentId}:${Date.now()}`,
    });

    let twinRun = null;
    if (runTwins) {
      const twinToken = mintTriggerToken({
        agentName: DIGITAL_TWIN_BUILDER_AGENT,
        dealId: leadId,
        conductiaTenantId: ctx.company.tenantId,
        scopes: digitalTwinScopes(),
        userId: ctx.user.id,
        userEmail: ctx.user.email,
      });
      twinRun = await ctx.plane.triggerSkill({
        agentName: DIGITAL_TWIN_BUILDER_AGENT,
        tenantId: ctx.config.tenantId,
        leadId,
        token: twinToken,
        requestedBy,
        triggerType: 'document_uploaded',
        documentId: document.documentId,
        idempotencyKey: `twin:${leadId}:${document.documentId}:${Date.now()}`,
      });
    }

    // One CREATE `agent_run` row per started run, shaped like the presearch
    // trigger's: executionBelongsToCompany binds the runs/ poll, answer and
    // cancel routes to it, and agentRunRequester bills the run to its
    // requester. The UPLOAD row records the filed debrief. One insert, so
    // either every row lands or none does.
    const runRows = [
      { agent: SOURCE_INTELLIGENCE_AGENT, executionId: sourceRun.executionId },
      ...(twinRun ? [{ agent: DIGITAL_TWIN_BUILDER_AGENT, executionId: twinRun.executionId }] : []),
    ].map((run) => ({
      actor_id: ctx.user.id,
      action: AUDIT_ACTION.CREATE,
      detail: {
        kind: 'agent_run',
        agent: run.agent,
        companyId: leadId,
        documentId: document.documentId,
        executionId: run.executionId,
      },
    }));
    const { error: auditError } = await ctx.admin.from('audit_log').insert([
      {
        actor_id: ctx.user.id,
        action: AUDIT_ACTION.UPLOAD,
        detail: {
          kind: 'agent_run',
          agent: SOURCE_INTELLIGENCE_AGENT,
          companyId: leadId,
          documentId: document.documentId,
          sourceExecutionId: sourceRun.executionId,
          twinExecutionId: twinRun?.executionId ?? null,
        },
      },
      ...runRows,
    ]);
    if (auditError) return auditFailed(auditError, 'The debrief was saved, but its audit record could not be written. Contact compliance before retrying.');

    return NextResponse.json(
      {
        documentId: document.documentId,
        sourceRun,
        twinRun,
      },
      { status: 202 },
    );
  } catch (error) {
    return ignatiousErrorResponse(error);
  }
}
