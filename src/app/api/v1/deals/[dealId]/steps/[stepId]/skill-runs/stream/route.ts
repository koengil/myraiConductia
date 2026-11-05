import { randomUUID } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  classifyInternalUser,
  resolveDealStepCapabilities,
  userCanAccessDeal,
} from '@/lib/api/v1/access';
import { recordAiUsage } from '@/lib/ai/usage';
import { auditFailed, jsonError, requireApiUser } from '@/lib/api/v1/http';
import { dealNotVisible } from '@/lib/api/v1/dealNotVisible';
import { AUDIT_ACTION } from '@/lib/constants/audit';
import { TABLE } from '@/lib/constants/tables';
import { loadDealByIdOrCode } from '@/lib/dataroom/steps';
import { requireFlag } from '@/lib/flags/requireFlag';
import { createSkillBench } from '@/lib/ignatious/bench';
import { streamMeteredBenchResponse } from '@/lib/ignatious/benchRequest';
import {
  leadIdForDeal,
  readIgnatiousConfig,
  SKILL_STEP_RUN_AGENT,
} from '@/lib/ignatious/config';
import { IgnatiousRequestError } from '@/lib/ignatious/control-plane';
import { SKILL_SERVICE_UNCONFIGURED_MESSAGE } from '@/lib/ignatious/failure';
import { mintTriggerToken, skillStepRunScopes } from '@/lib/ignatious/jwt';
import { ignatiousErrorResponse } from '@/lib/ignatious/routeContext';
import { isUuid } from '@/lib/skillPublication/parse';
import { MAX_INSTRUCTIONS, parseInputValues } from '@/lib/skillRun/inputs';
import { resolveStepBinding } from '@/lib/skillRun/step';
import type { SkillReference } from '@/lib/skillRun/types';
import {
  isAvailable,
  parseSkillReference,
  readStepVersions,
  referencesMatch,
  resolveMountTripleForStep,
} from '@/lib/skillRun/versions';

type RouteContext = { params: Promise<{ dealId: string; stepId: string }> };

const STEP_COLUMNS = 'id, step_id, origin, removed_at, work, definition, assigned_to, status';
const BINDING_COLUMNS = 'kind, skill_id, version_id, mount_name, mount_version, digest';

export async function POST(request: Request, context: RouteContext) {
  const gate = await requireFlag('skill_authoring');
  if (gate) return gate;

  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const { dealId, stepId } = await context.params;

  let body: {
    runId?: unknown;
    version?: unknown;
    model?: unknown;
    inputs?: unknown;
    instructions?: unknown;
  };
  try {
    body = (await request.json()) as {
      runId?: unknown;
      version?: unknown;
      model?: unknown;
      inputs?: unknown;
      instructions?: unknown;
    };
  } catch {
    return jsonError('Invalid JSON body', 400);
  }
  const runId = typeof body.runId === 'string' ? body.runId.trim() : '';
  if (!isUuid(runId)) return jsonError('runId must be a UUID', 422);

  const inputs = body.inputs === undefined || body.inputs === null ? {} : parseInputValues(body.inputs);
  if (inputs === null) return jsonError('inputs must map names to text, numbers or booleans', 422);
  const instructionsText = typeof body.instructions === 'string' ? body.instructions.trim() : '';
  if (instructionsText.length > MAX_INSTRUCTIONS) return jsonError('instructions are too long', 422);
  const instructions = instructionsText === '' ? null : instructionsText;

  const deal = await loadDealByIdOrCode(auth.admin, dealId);
  if (!deal) return jsonError('Deal not found', 404);
  if (!(await userCanAccessDeal(auth.admin, auth.user.id, deal.id))) {
    return dealNotVisible();
  }

  const wall = await classifyInternalUser(auth.admin, auth.user.id);
  if (wall === 'error') return jsonError('Profile lookup failed', 500);
  if (wall !== 'internal') return jsonError('Forbidden', 403);

  const { data: row } = await auth.admin
    .from(TABLE.DEAL_STEPS)
    .select(STEP_COLUMNS)
    .eq('deal_id', deal.id)
    .eq('step_id', stepId)
    .maybeSingle();

  const capabilities = await resolveDealStepCapabilities(auth.admin, auth.user.id, deal.id, {
    assigned_to: (row?.assigned_to as string | null) ?? null,
    status: (row?.status as string) ?? 'pending',
  });
  if (capabilities === 'unreadable') return jsonError('Profile lookup failed', 500);
  if (!capabilities.canEditWork) return jsonError('Not permitted to run this step', 403);

  const binding = row && typeof row.id === 'string' ? await readBinding(auth.admin, row.id) : null;

  let mount: { name: string; version: number; digest: string } | null;
  try {
    mount = await resolveMountTripleForStep(stepId);
  } catch (error) {
    if (error instanceof IgnatiousRequestError) return ignatiousErrorResponse(error);
    throw error;
  }

  const resolved = resolveStepBinding(row, binding, mount?.name ?? null, mount?.version ?? null, mount?.digest ?? null);
  if (!resolved.ok) {
    if (resolved.code === 'not_found') return jsonError('Unknown step', 404);
    return jsonError(
      resolved.code === 'removed' ? 'This step was removed' : 'This step has no skill attached',
      409,
    );
  }

  const requested = body.version === undefined ? null : parseSkillReference(body.version);
  if (body.version !== undefined && requested === null) {
    return jsonError('That version reference is not valid', 422);
  }
  if (requested && !referencesMatch(requested, resolved.step.binding)) {
    let available;
    try {
      available = await readStepVersions(auth.admin, deal, stepId);
    } catch (error) {
      if (error instanceof IgnatiousRequestError) return ignatiousErrorResponse(error);
      throw error;
    }
    if (available?.projectUnavailableReason) {
      return jsonError(available.projectUnavailableReason, 502);
    }
    if (!available || !isAvailable(available, requested)) {
      return jsonError('That version is not available for this step', 422);
    }
  }
  const reference: SkillReference = requested ?? resolved.step.binding;
  const model = typeof body.model === 'string' && body.model.trim() !== '' ? body.model.trim() : null;

  const config = readIgnatiousConfig();
  if (!config) return jsonError(SKILL_SERVICE_UNCONFIGURED_MESSAGE, 503);

  // Fail closed: the tenant claim is what the callback's lead boundary trusts,
  // so a deal with no tenant must not get a token rather than an unscoped one.
  const { data: owner, error: ownerError } = await auth.admin
    .from(TABLE.DEALS)
    .select('tenant_id')
    .eq('id', deal.id)
    .maybeSingle();
  if (ownerError) return jsonError('Deal lookup failed', 500);
  const tenantId = (owner?.tenant_id as string | null | undefined) ?? null;
  if (!tenantId) return jsonError('Deal has no firm', 500);

  const token = mintTriggerToken({
    agentName: SKILL_STEP_RUN_AGENT,
    dealId: deal.id,
    conductiaTenantId: tenantId,
    scopes: skillStepRunScopes(),
    userId: auth.user.id,
    userEmail: auth.user.email,
    stepId: resolved.step.stepId,
    stepTitle: resolved.step.title,
  });

  // The ledger key is ours, not the browser's runId: a reused or colliding
  // runId would otherwise be ignored by the ledger upsert and skip the budget
  // check. Kept on the audit row so the ledger row traces back to this run.
  const ledgerId = randomUUID();
  const { error: auditError } = await auth.admin.from(TABLE.AUDIT_LOG).insert({
    actor_id: auth.user.id,
    action: AUDIT_ACTION.CREATE,
    deal_id: deal.id,
    detail: {
      kind: 'skill_run',
      stepKey: stepId,
      title: resolved.step.title,
      dealStepId: resolved.step.dealStepId,
      runId,
      ledgerId,
      reference,
    },
  });
  if (auditError) return auditFailed(auditError, 'The skill run could not be recorded, so it was not started. Try again.');

  try {
    const upstream = await createSkillBench(config).startSkillRun(
      {
        runId,
        skill: reference,
        projectId: deal.id,
        inputs,
        instructions,
        tenantId: config.tenantId,
        leadId: leadIdForDeal(config, deal),
        model,
        token,
      },
      request.signal,
    );

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text();
      return new Response(text || `Skill bench answered ${String(upstream.status)}`, {
        status: upstream.status >= 400 ? upstream.status : 502,
        headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
      });
    }

    // The run's cost goes on the AI spend ledger (#155, plan v5 W3), read off
    // the bench's `done` frame. One row per run, keyed by the server's ledger id.
    return streamMeteredBenchResponse(upstream, (usage) =>
      recordAiUsage(auth.admin, {
        tenantId,
        dealId: deal.id,
        actorId: auth.user.id,
        source: 'skill_run',
        task: resolved.step.stepId,
        externalId: ledgerId,
        model: usage.model,
        costUsd: usage.costUsd,
      }),
    );
  } catch (error) {
    return ignatiousErrorResponse(error);
  }
}

async function readBinding(
  admin: SupabaseClient,
  dealStepId: string,
): Promise<Record<string, unknown> | null> {
  const { data } = await admin
    .from(TABLE.DEAL_STEP_SKILL_BINDINGS)
    .select(BINDING_COLUMNS)
    .eq('deal_step_id', dealStepId)
    .maybeSingle();
  return (data as Record<string, unknown> | null) ?? null;
}
