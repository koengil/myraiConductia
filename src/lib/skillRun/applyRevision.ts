import { randomUUID } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';

import { AUDIT_ACTION } from '@/lib/constants/audit';
import { SKILL_RUN_SOURCE } from '@/lib/constants/dealSteps';
import { TABLE } from '@/lib/constants/tables';
import { recordAiUsage } from '@/lib/ai/usage';
import { errorCodeOf } from '@/lib/errors/upstream';
import { createSkillBench } from '@/lib/ignatious/bench';
import {
  leadIdForDeal,
  SKILL_RUN_REVISION_AGENT,
  type IgnatiousConfig,
} from '@/lib/ignatious/config';
import { mintTriggerToken, skillRunRevisionScopes } from '@/lib/ignatious/jwt';
import { isBenchModelAlias } from '@/lib/ignatious/processTag';

import type { RootRun } from './revisionStore';
import {
  readRevisionStream,
  type EngineOutcome,
  type EngineReplacement,
} from './revisionStream';
import {
  cleanReplacement,
  countBy,
  digestOf,
  editsDigest,
  keepsStructure,
  shiftRange,
  splice,
  STRUCTURE_PROBLEM,
  STRUCTURE_REASON,
  storageProblem,
  type Replacement,
} from './revisions';
import type {
  EditRecord,
  EditRequest,
  RevisionInputs,
  SkillReference,
} from './types';

export const HEAD_MOVED_MESSAGE =
  'This output changed while you were editing. Your edits are kept. Check them against the new version.';
const NOT_RECORDED_MESSAGE = 'The revision could not be recorded.';

export type RevisionTarget = {
  admin: SupabaseClient;
  dealId: string;
  stepKey: string;
  stepTitle: string | null;
  actorId: string;
  root: RootRun;
  parent: { id: string; text: string };
};

export type RevisionResult =
  | { ok: true; revisionId: string }
  | { ok: false; status: number; message: string };

export type Engine = {
  model: string | null;
  costUsd: number | null;
  providerRunId: string | null;
  startedAt: string | null;
};

const NO_ENGINE: Engine = { model: null, costUsd: null, providerRunId: null, startedAt: null };

type HandEdit = Extract<EditRequest, { kind: 'hand' }>;

export function failRemaining(edits: readonly EditRecord[], reason: string): EditRecord[] {
  return edits.map((edit) =>
    edit.status === 'unresolved'
      ? edit
      : {
          id: edit.id,
          kind: edit.kind,
          start: edit.start,
          end: edit.end,
          ...(edit.comment === undefined ? {} : { comment: edit.comment }),
          ...(edit.teach === true ? { teach: true as const } : {}),
          status: 'failed',
          reason,
        },
  );
}

type AuditError = { message: string; code?: string };

function auditDetail(target: RevisionTarget, detail: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: 'skill_run_revision',
    stepKey: target.stepKey,
    title: target.stepTitle,
    dealStepId: target.root.dealStepId,
    rootRunId: target.root.id,
    parentRunId: target.parent.id,
    ...detail,
  };
}

export async function auditRevisionStarted(
  target: RevisionTarget,
  revisionId: string,
  edits: EditRequest[],
): Promise<AuditError | null> {
  const { error } = await target.admin.from(TABLE.AUDIT_LOG).insert({
    actor_id: target.actorId,
    action: AUDIT_ACTION.CREATE,
    deal_id: target.dealId,
    detail: auditDetail(target, {
      phase: 'started',
      revisionId,
      edits: countBy(edits.map((edit) => edit.kind)),
      editsDigest: editsDigest(edits),
    }),
  });
  return error ?? null;
}

function recordedDetail(
  revisionId: string,
  inputs: RevisionInputs,
  resultText: string | null,
  model: string | null,
): Record<string, unknown> {
  return {
    phase: 'recorded',
    revisionId,
    revisionKind: inputs.kind,
    outcome: resultText === null ? 'failed' : 'succeeded',
    edits: inputs.kind === 'edits' ? countBy(inputs.edits.map((edit) => edit.status)) : {},
    ...(inputs.kind === 'restore' ? { restoredFrom: inputs.restoredFrom } : {}),
    model,
    resultDigest: resultText === null ? null : digestOf(resultText),
  };
}

export async function writeRow(
  target: RevisionTarget,
  revisionId: string,
  inputs: RevisionInputs,
  result: { text: string } | { error: string },
  engine: Engine = NO_ENGINE,
): Promise<'written' | 'head_moved' | 'refused'> {
  const succeeded = 'text' in result;
  const resultText = succeeded ? result.text : null;
  const { error } = await target.admin.rpc('record_skill_run_revision', {
    p_run: {
      id: revisionId,
      deal_id: target.dealId,
      deal_step_id: target.root.dealStepId,
      actor_id: target.actorId,
      source: SKILL_RUN_SOURCE.REVISION,
      parent_run_id: target.parent.id,
      root_run_id: target.root.id,
      skill_id: target.root.skillId,
      version_id: target.root.versionId,
      mount_name: target.root.mountName,
      mount_version: target.root.mountVersion,
      digest: target.root.digest,
      inputs,
      outcome: succeeded ? 'succeeded' : 'failed',
      result_text: resultText,
      error_message: succeeded ? null : result.error,
      model: engine.model,
      cost_usd: engine.costUsd,
      provider_run_id: engine.providerRunId,
      started_at: engine.startedAt,
    },
    p_audit: auditDetail(target, recordedDetail(revisionId, inputs, resultText, engine.model)),
  });
  if (!error) return 'written';
  if (succeeded && (error as { code?: string }).code === '23505') return 'head_moved';
  console.error('[skill-revision] the revision was not recorded', revisionId, {
    code: errorCodeOf(error),
  });
  return 'refused';
}

export async function recordFailure(
  target: RevisionTarget,
  revisionId: string,
  inputs: RevisionInputs,
  message: string,
  engine: Engine = NO_ENGINE,
): Promise<void> {
  const written = await writeRow(target, revisionId, inputs, { error: message }, engine);
  if (written !== 'written') {
    console.error('[skill-revision] a failed attempt could not be recorded', revisionId);
  }
}

async function commit(
  target: RevisionTarget,
  inputs: RevisionInputs,
  text: string,
): Promise<RevisionResult> {
  const revisionId = randomUUID();
  const written = await writeRow(target, revisionId, inputs, { text });
  if (written === 'head_moved') {
    const failed: RevisionInputs =
      inputs.kind === 'edits'
        ? { ...inputs, edits: failRemaining(inputs.edits, HEAD_MOVED_MESSAGE) }
        : inputs;
    await recordFailure(target, revisionId, failed, HEAD_MOVED_MESSAGE);
    return { ok: false, status: 409, message: HEAD_MOVED_MESSAGE };
  }
  if (written === 'refused') return { ok: false, status: 500, message: NOT_RECORDED_MESSAGE };
  return { ok: true, revisionId };
}

function handReplacements(edits: readonly EditRequest[]): Replacement[] {
  return edits.flatMap((edit) =>
    edit.kind === 'hand'
      ? [{ start: edit.start, end: edit.end, text: cleanReplacement(edit.text) }]
      : [],
  );
}

export function handEditsProblem(parentText: string, edits: readonly EditRequest[]): string | null {
  const replacements = handReplacements(edits);
  const problem = storageProblem(splice(parentText, replacements).text);
  if (problem) return problem;
  return keepsStructure(parentText, replacements) ? null : STRUCTURE_PROBLEM;
}

export async function recordHandRevision(
  target: RevisionTarget,
  edits: EditRequest[],
): Promise<RevisionResult> {
  const hand = edits.filter((edit): edit is HandEdit => edit.kind === 'hand');
  const problem = handEditsProblem(target.parent.text, hand);
  if (problem) return { ok: false, status: 422, message: problem };
  const result = splice(target.parent.text, handReplacements(hand));

  return commit(
    target,
    {
      kind: 'edits',
      edits: hand.map((edit, index) => ({
        id: randomUUID(),
        kind: 'hand',
        start: edit.start,
        end: edit.end,
        status: 'applied',
        resultStart: result.ranges[index].start,
        resultEnd: result.ranges[index].end,
      })),
    },
    result.text,
  );
}

export function recordRestore(
  target: RevisionTarget,
  version: { id: string; text: string },
): Promise<RevisionResult> {
  return commit(target, { kind: 'restore', restoredFrom: version.id }, version.text);
}

export const ENGINE_TIMEOUT_MS = 240_000;
export const ENGINE_TIMEOUT_MESSAGE = 'The edit took too long and was stopped. Nothing was changed.';
export const ENGINE_FAILED_MESSAGE = 'The edit could not be applied. Nothing was changed.';
export const NO_REPLACEMENTS_MESSAGE = 'The assistant returned no replacements. Nothing was changed.';
export const NOTHING_APPLIED_MESSAGE = 'None of the comments could be applied.';
export const MISSING_REASON = 'The assistant returned nothing for this passage.';
const MAX_REASON = 500;

export type CommentBatchJob = RevisionTarget & {
  revisionId: string;
  edits: EditRequest[];
  tenantId: string;
  deal: { id: string; code: string };
  config: IgnatiousConfig;
  actorEmail: string;
};

type IndexedReplacement = Replacement & { index: number };

type EngineCall = { outcome: EngineOutcome | null; failure: string | null };

function referenceOf(root: RootRun): SkillReference | null {
  if (root.digest === null) return null;
  if (root.mountName !== null && root.mountVersion !== null) {
    return { kind: 'mount', name: root.mountName, version: root.mountVersion, digest: root.digest };
  }
  if (root.skillId !== null && root.versionId !== null) {
    return { kind: 'publication', skillId: root.skillId, versionId: root.versionId, digest: root.digest };
  }
  return null;
}

async function callEngine(
  job: CommentBatchJob,
  records: readonly EditRecord[],
  hand: readonly IndexedReplacement[],
  options: { fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<EngineCall> {
  const passages = job.edits.flatMap((edit, index) =>
    edit.kind === 'comment'
      ? [{ id: records[index].id, ...shiftRange(edit, hand), comment: edit.comment }]
      : [],
  );
  const token = mintTriggerToken({
    agentName: SKILL_RUN_REVISION_AGENT,
    dealId: job.deal.id,
    conductiaTenantId: job.tenantId,
    scopes: skillRunRevisionScopes(),
    userId: job.actorId,
    userEmail: job.actorEmail,
    stepId: job.stepKey,
    ...(job.stepTitle ? { stepTitle: job.stepTitle } : {}),
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? ENGINE_TIMEOUT_MS);
  try {
    const upstream = await createSkillBench(job.config, options.fetchImpl).startSkillRunRevision(
      {
        revisionId: job.revisionId,
        skill: referenceOf(job.root),
        projectId: job.deal.id,
        document: splice(job.parent.text, hand).text,
        passages,
        tenantId: job.config.tenantId,
        leadId: leadIdForDeal(job.config, job.deal),
        model: isBenchModelAlias(job.root.model) ? job.root.model : null,
        token,
      },
      controller.signal,
    );
    if (!upstream.ok || !upstream.body) {
      console.error('[skill-revision] the engine refused the call', job.revisionId, {
        status: upstream.status,
      });
      return { outcome: null, failure: ENGINE_FAILED_MESSAGE };
    }
    const outcome = await readRevisionStream(upstream.body);
    if (outcome.error !== null || !outcome.finished || outcome.replacements === null) {
      console.error('[skill-revision] the engine turn did not end cleanly', job.revisionId, {
        finished: outcome.finished,
        hadError: outcome.error !== null,
        hadReplacements: outcome.replacements !== null,
      });
      const cleanWithoutReplacements = outcome.error === null && outcome.finished;
      return {
        outcome,
        failure: cleanWithoutReplacements ? NO_REPLACEMENTS_MESSAGE : ENGINE_FAILED_MESSAGE,
      };
    }
    return { outcome, failure: null };
  } catch (caught) {
    console.error('[skill-revision] the engine call failed', job.revisionId, {
      code: errorCodeOf(caught),
      timedOut: controller.signal.aborted,
    });
    return {
      outcome: null,
      failure: controller.signal.aborted ? ENGINE_TIMEOUT_MESSAGE : ENGINE_FAILED_MESSAGE,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function settle(
  job: CommentBatchJob,
  records: readonly EditRecord[],
  hand: readonly IndexedReplacement[],
  outcome: EngineOutcome,
  engine: Engine,
): Promise<void> {
  const answers = outcome.replacements ?? new Map<string, EngineReplacement>();
  const applied: IndexedReplacement[] = [...hand];
  const edits = records.map((record, index): EditRecord => {
    const edit = job.edits[index];
    if (edit.kind === 'hand') return record;
    const answer = answers.get(record.id);
    if (answer && 'text' in answer) {
      const replacement = { index, start: edit.start, end: edit.end, text: cleanReplacement(answer.text) };
      if (!keepsStructure(job.parent.text, [...hand, replacement])) {
        return { ...record, status: 'unresolved', reason: STRUCTURE_REASON };
      }
      applied.push(replacement);
      return record;
    }
    return {
      ...record,
      status: 'unresolved',
      reason: (answer?.unresolved ?? MISSING_REASON).trim().slice(0, MAX_REASON),
    };
  });
  const mounted = outcome.skillMounted === null ? {} : { skillMounted: outcome.skillMounted };
  const fail = (reason: string, kept: EditRecord[]) =>
    recordFailure(job, job.revisionId, { kind: 'edits', edits: kept, ...mounted }, reason, engine);

  if (applied.length === 0) {
    await fail(NOTHING_APPLIED_MESSAGE, edits);
    return;
  }

  const result = splice(job.parent.text, applied);
  const problem =
    storageProblem(result.text) ?? (keepsStructure(job.parent.text, applied) ? null : STRUCTURE_PROBLEM);
  if (problem) {
    await fail(problem, failRemaining(edits, problem));
    return;
  }

  const finished = [...edits];
  applied.forEach((replacement, position) => {
    finished[replacement.index] = {
      ...finished[replacement.index],
      status: 'applied',
      resultStart: result.ranges[position].start,
      resultEnd: result.ranges[position].end,
    };
  });
  const inputs: RevisionInputs = { kind: 'edits', edits: finished, ...mounted };

  const written = await writeRow(job, job.revisionId, inputs, { text: result.text }, engine);
  if (written !== 'written') {
    const reason = written === 'head_moved' ? HEAD_MOVED_MESSAGE : ENGINE_FAILED_MESSAGE;
    await fail(reason, failRemaining(edits, reason));
  }
}

export async function applyCommentBatch(
  job: CommentBatchJob,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<void> {
  const startedAt = new Date().toISOString();
  const records: EditRecord[] = job.edits.map((edit) => ({
    id: randomUUID(),
    kind: edit.kind,
    start: edit.start,
    end: edit.end,
    ...(edit.kind === 'comment' ? { comment: edit.comment } : {}),
    ...(edit.kind === 'comment' && edit.teach === true ? { teach: true as const } : {}),
    status: 'failed',
  }));
  let call: EngineCall | null = null;

  try {
    const hand: IndexedReplacement[] = job.edits.flatMap((edit, index) =>
      edit.kind === 'hand'
        ? [{ index, start: edit.start, end: edit.end, text: cleanReplacement(edit.text) }]
        : [],
    );
    call = await callEngine(job, records, hand, options);
    const engine: Engine = {
      model: call.outcome?.alias ?? null,
      costUsd: call.outcome?.costUsd ?? null,
      providerRunId: call.outcome?.providerRunId ?? null,
      startedAt,
    };
    if (call.failure !== null || call.outcome === null) {
      const reason = call.failure ?? ENGINE_FAILED_MESSAGE;
      await recordFailure(
        job,
        job.revisionId,
        { kind: 'edits', edits: failRemaining(records, reason) },
        reason,
        engine,
      );
    } else {
      await settle(job, records, hand, call.outcome, engine);
    }
  } catch (caught) {
    console.error('[skill-revision] the batch could not be settled', job.revisionId, {
      code: errorCodeOf(caught),
    });
    try {
      await recordFailure(
        job,
        job.revisionId,
        { kind: 'edits', edits: failRemaining(records, ENGINE_FAILED_MESSAGE) },
        ENGINE_FAILED_MESSAGE,
        { ...NO_ENGINE, startedAt },
      );
    } catch (again) {
      console.error('[skill-revision] a failed attempt could not be recorded', job.revisionId, {
        code: errorCodeOf(again),
      });
    }
  } finally {
    if (call?.outcome?.finished) {
      await recordAiUsage(job.admin, {
        tenantId: job.tenantId,
        dealId: job.dealId,
        actorId: job.actorId,
        source: 'skill_revision',
        task: job.stepKey,
        externalId: job.revisionId,
        model: call.outcome.model,
        costUsd: call.outcome.costUsd,
      });
    }
  }
}
