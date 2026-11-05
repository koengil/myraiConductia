import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  classifyInternalUser,
  resolveDealStepCapabilities,
  userCanAccessDeal,
} from '@/lib/api/v1/access';
import { auditFailed, jsonError, requireApiUser } from '@/lib/api/v1/http';
import { dealNotVisible } from '@/lib/api/v1/dealNotVisible';
import { AUDIT_ACTION } from '@/lib/constants/audit';
import { SKILL_RUN_SOURCE } from '@/lib/constants/dealSteps';
import { TABLE } from '@/lib/constants/tables';
import { loadDealByIdOrCode } from '@/lib/dataroom/steps';
import { requireFlag } from '@/lib/flags/requireFlag';
import { IgnatiousRequestError } from '@/lib/ignatious/control-plane';
import { ignatiousErrorResponse } from '@/lib/ignatious/routeContext';
import { parseInputValues, sameInputValues } from '@/lib/skillRun/inputs';
import { parseRunRecord } from '@/lib/skillRun/parse';
import { chainOf, readRevisionRows, summarize, type RevisionRow } from '@/lib/skillRun/revisionStore';
import { resolveStepBinding } from '@/lib/skillRun/step';
import { readTeachings, sentEditIds } from '@/lib/skillRun/teachingStore';
import type { SkillReference, SkillRunSummary } from '@/lib/skillRun/types';
import {
  isAvailable,
  readStepVersions,
  referencesMatch,
  resolveMountTripleForStep,
} from '@/lib/skillRun/versions';

type RouteContext = { params: Promise<{ dealId: string; stepId: string }> };

const HISTORY_LIMIT = 20;
const STEP_COLUMNS = 'id, step_id, origin, removed_at, work, definition, assigned_to, status';
const BINDING_COLUMNS = 'kind, skill_id, version_id, mount_name, mount_version, digest';
const RUN_COLUMNS =
  'id, outcome, input, inputs, result_text, error_message, actor_id, source, skill_id, version_id, mount_name, mount_version, digest, model, clamped_from, cost_usd, started_at, created_at';
const HISTORY_UNREADABLE = 'Run history could not be read';
const IMPORTED_ACTOR_LABEL = 'Imported from the bench';

export async function POST(request: Request, context: RouteContext) {
  const gate = await requireFlag('skill_authoring');
  if (gate) return gate;

  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const { dealId, stepId } = await context.params;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonError('Invalid JSON body', 400);
  }
  const parsed = parseRunRecord(raw);
  if ('error' in parsed) return jsonError(parsed.error, 422);

  const deal = await loadDealByIdOrCode(auth.admin, dealId);
  if (!deal) return jsonError('Deal not found', 404);
  if (!(await userCanAccessDeal(auth.admin, auth.user.id, deal.id))) {
    return dealNotVisible();
  }

  const wall = await classifyInternalUser(auth.admin, auth.user.id);
  if (wall === 'error') return jsonError('Profile lookup failed', 500);
  if (wall !== 'internal') return jsonError('Forbidden', 403);

  const row = await readStep(auth.admin, deal.id, stepId);

  const capabilities = await resolveDealStepCapabilities(auth.admin, auth.user.id, deal.id, {
    assigned_to: (row?.assigned_to as string | null) ?? null,
    status: (row?.status as string) ?? 'pending',
  });
  if (capabilities === 'unreadable') return jsonError('Profile lookup failed', 500);
  if (!capabilities.canEditWork) return jsonError('Not permitted to run this step', 403);

  const binding = row && typeof row.id === 'string' ? await readBinding(auth.admin, row.id) : null;

  let resolved = resolveStepBinding(row, binding, null, null, null);
  if (!resolved.ok && resolved.code === 'not_skill_backed') {
    let mount: { name: string; version: number; digest: string } | null;
    try {
      mount = await resolveMountTripleForStep(stepId);
    } catch (error) {
      if (error instanceof IgnatiousRequestError) return ignatiousErrorResponse(error);
      throw error;
    }
    resolved = resolveStepBinding(
      row,
      binding,
      mount?.name ?? null,
      mount?.version ?? null,
      mount?.digest ?? null,
    );
  }
  if (!resolved.ok) {
    if (resolved.code === 'not_found') return jsonError('Unknown step', 404);
    return jsonError(
      resolved.code === 'removed' ? 'This step was removed' : 'This step has no skill attached',
      409,
    );
  }

  if (parsed.reference && !referencesMatch(parsed.reference, resolved.step.binding)) {
    let available;
    try {
      available = await readStepVersions(auth.admin, deal, stepId);
    } catch (error) {
      if (error instanceof IgnatiousRequestError) return ignatiousErrorResponse(error);
      throw error;
    }
    if (!available || !isAvailable(available, parsed.reference)) {
      return jsonError('That version is not available for this step', 422);
    }
  }

  const reference: SkillReference = parsed.reference ?? resolved.step.binding;

  const insert = {
    id: parsed.runId,
    deal_id: deal.id,
    deal_step_id: resolved.step.dealStepId,
    actor_id: auth.user.id,
    skill_id: reference.kind === 'publication' ? reference.skillId : null,
    version_id: reference.kind === 'publication' ? reference.versionId : null,
    mount_name: reference.kind === 'mount' ? reference.name : null,
    mount_version: reference.kind === 'mount' ? reference.version : null,
    digest: reference.digest,
    model: parsed.model,
    clamped_from: parsed.clampedFrom,
    source: SKILL_RUN_SOURCE.EXECUTION,
    input: parsed.instructions,
    inputs: parsed.inputs,
    outcome: parsed.outcome,
    result_text: parsed.resultText,
    error_message: parsed.errorMessage,
    provider_run_id: parsed.providerRunId,
    started_at: parsed.startedAt,
  };

  const { data: stored, error } = await auth.admin
    .from(TABLE.DEAL_STEP_SKILL_RUNS)
    .insert(insert)
    .select(RUN_COLUMNS)
    .single();

  if (error && (error as { code?: string }).code === '23505') {
    const existing = await readRuns(auth.admin, deal.id, resolved.step.dealStepId);
    if (existing === 'unreadable') return jsonError(HISTORY_UNREADABLE, 500);
    const match = existing.find((run) => run.id === parsed.runId);
    if (!match) return jsonError('That run id is already recorded', 409);
    const same =
      match.input === parsed.instructions &&
      sameInputValues(match.inputs, parsed.inputs) &&
      match.outcome === parsed.outcome &&
      match.resultText === parsed.resultText;
    if (!same) {
      return jsonError('That run id was already recorded with different content', 409);
    }
    return NextResponse.json({ run: match });
  }
  if (error || !stored) return jsonError(error?.message ?? 'Failed to record the run', 500);

  const { error: auditError } = await auth.admin.from(TABLE.AUDIT_LOG).insert({
    actor_id: auth.user.id,
    action: AUDIT_ACTION.CREATE,
    deal_id: deal.id,
    detail: {
      kind: 'skill_run',
      stepKey: stepId,
      title: resolved.step.title,
      dealStepId: resolved.step.dealStepId,
      runId: parsed.runId,
      reference,
      model: parsed.model,
      clampedFrom: parsed.clampedFrom,
      outcome: parsed.outcome,
    },
  });
  if (auditError) return auditFailed(auditError, 'The skill run was saved, but its audit record could not be written. Contact compliance before retrying.');

  const decorated = await decorate(auth.admin, deal.id, [stored as Record<string, unknown>], []);
  if (decorated === 'unreadable') return jsonError(HISTORY_UNREADABLE, 500);
  return NextResponse.json({ run: decorated[0] }, { status: 201 });
}

export async function GET(_request: Request, context: RouteContext) {
  const gate = await requireFlag('skill_authoring');
  if (gate) return gate;

  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const { dealId, stepId } = await context.params;

  const deal = await loadDealByIdOrCode(auth.admin, dealId);
  if (!deal) return jsonError('Deal not found', 404);
  if (!(await userCanAccessDeal(auth.admin, auth.user.id, deal.id))) {
    return dealNotVisible();
  }

  const wall = await classifyInternalUser(auth.admin, auth.user.id);
  if (wall === 'error') return jsonError('Profile lookup failed', 500);
  if (wall !== 'internal') return jsonError('Forbidden', 403);

  const row = await readStep(auth.admin, deal.id, stepId);
  if (!row || typeof row.id !== 'string') return jsonError('Unknown step', 404);

  const runs = await readRuns(auth.admin, deal.id, row.id);
  if (runs === 'unreadable') return jsonError(HISTORY_UNREADABLE, 500);
  return NextResponse.json({ runs });
}

async function readStep(
  admin: SupabaseClient,
  dealId: string,
  stepId: string,
): Promise<Record<string, unknown> | null> {
  const { data } = await admin
    .from(TABLE.DEAL_STEPS)
    .select(STEP_COLUMNS)
    .eq('deal_id', dealId)
    .eq('step_id', stepId)
    .maybeSingle();
  return (data as Record<string, unknown> | null) ?? null;
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

async function readRuns(
  admin: SupabaseClient,
  dealId: string,
  dealStepId: string,
): Promise<SkillRunSummary[] | 'unreadable'> {
  const { data } = await admin
    .from(TABLE.DEAL_STEP_SKILL_RUNS)
    .select(RUN_COLUMNS)
    .eq('deal_step_id', dealStepId)
    .neq('source', SKILL_RUN_SOURCE.REVISION)
    .order('created_at', { ascending: false })
    .limit(HISTORY_LIMIT);
  return decorate(admin, dealId, (data ?? []) as Record<string, unknown>[]);
}

function referenceFromRunRow(row: Record<string, unknown>): SkillReference | null {
  if (typeof row.mount_name === 'string' && typeof row.mount_version === 'number') {
    return { kind: 'mount', name: row.mount_name, version: row.mount_version, digest: row.digest as string };
  }
  if (
    typeof row.skill_id === 'string' &&
    typeof row.version_id === 'string' &&
    typeof row.digest === 'string'
  ) {
    return {
      kind: 'publication',
      skillId: row.skill_id,
      versionId: row.version_id,
      digest: row.digest,
    };
  }
  return null;
}

async function decorate(
  admin: SupabaseClient,
  dealId: string,
  rows: Record<string, unknown>[],
  knownRevisions?: RevisionRow[],
): Promise<SkillRunSummary[] | 'unreadable'> {
  if (rows.length === 0) return [];
  const runIds = rows.map((row) => row.id as string);
  const revisionRows = knownRevisions ?? (await readRevisionRows(admin, runIds));
  if (revisionRows === 'unreadable') return 'unreadable';
  const teachings = await readTeachings(admin, revisionRows);
  if (teachings === 'unreadable') return 'unreadable';
  const sent = sentEditIds(teachings);
  const actorIds = [
    ...new Set(
      [...rows.map((row) => row.actor_id), ...revisionRows.map((row) => row.actorId)].filter(
        (id): id is string => typeof id === 'string',
      ),
    ),
  ];

  const { data: people } =
    actorIds.length === 0
      ? { data: [] as Record<string, unknown>[] }
      : await admin.from(TABLE.USERS).select('id, full_name, display_name, email').in('id', actorIds);
  const { data: documents } = await admin
    .from(TABLE.DOCUMENTS)
    .select('id, name, folder, created_at, step_skill_run_id')
    .eq('deal_id', dealId)
    .in('step_skill_run_id', runIds);

  const nameFor = new Map(
    ((people ?? []) as Record<string, unknown>[]).map((person) => [
      person.id as string,
      (person.display_name as string | null) ??
        (person.full_name as string | null) ??
        (person.email as string),
    ]),
  );

  return rows.map((row) => {
    const chain = chainOf(
      { id: row.id as string, text: (row.result_text as string | null) ?? null },
      revisionRows,
    );
    return {
      id: row.id as string,
      outcome: row.outcome as SkillRunSummary['outcome'],
      actorName:
        row.source === SKILL_RUN_SOURCE.IMPORTED
          ? IMPORTED_ACTOR_LABEL
          : (nameFor.get(row.actor_id as string) ?? 'Unknown'),
      input: (row.input as string | null) ?? null,
      inputs: parseInputValues(row.inputs) ?? {},
      resultText: (row.result_text as string | null) ?? null,
      errorMessage: (row.error_message as string | null) ?? null,
      costUsd: (row.cost_usd as number | null) ?? null,
      startedAt: (row.started_at as string | null) ?? null,
      createdAt: row.created_at as string,
      binding: referenceFromRunRow(row),
      model: (row.model as string | null) ?? null,
      clampedFrom: (row.clamped_from as string | null) ?? null,
      documents: ((documents ?? []) as Record<string, unknown>[])
        .filter((doc) => doc.step_skill_run_id === row.id)
        .map((doc) => ({
          id: doc.id as string,
          name: doc.name as string,
          folder: (doc.folder as string | null) ?? null,
          createdAt: doc.created_at as string,
        })),
      headId: chain.headId,
      headText: chain.headText,
      revisions: summarize(chain, (actorId) => nameFor.get(actorId ?? '') ?? 'Unknown', sent),
    };
  });
}
