import type { SupabaseClient } from '@supabase/supabase-js';

import { SKILL_RUN_SOURCE } from '@/lib/constants/dealSteps';
import { TABLE } from '@/lib/constants/tables';
import { errorCodeOf } from '@/lib/errors/upstream';

import { parseRevisionInputs } from './revisions';
import type { RevisionSummary, RunOutcome } from './types';

const REVISION_COLUMNS =
  'id, outcome, inputs, result_text, error_message, actor_id, parent_run_id, root_run_id, created_at';
const ROOT_COLUMNS =
  'id, deal_step_id, outcome, result_text, skill_id, version_id, mount_name, mount_version, digest, model';

export type RevisionRow = {
  id: string;
  outcome: RunOutcome;
  inputs: unknown;
  resultText: string | null;
  errorMessage: string | null;
  actorId: string | null;
  parentId: string;
  rootId: string;
  createdAt: string;
};

export type OutputChain = {
  headId: string;
  headText: string | null;
  versions: { id: string; text: string }[];
  rows: RevisionRow[];
};

export type RootRun = {
  id: string;
  dealStepId: string;
  skillId: string | null;
  versionId: string | null;
  mountName: string | null;
  mountVersion: number | null;
  digest: string | null;
  model: string | null;
};

function toRow(raw: Record<string, unknown>): RevisionRow {
  return {
    id: raw.id as string,
    outcome: raw.outcome as RunOutcome,
    inputs: raw.inputs,
    resultText: (raw.result_text as string | null) ?? null,
    errorMessage: (raw.error_message as string | null) ?? null,
    actorId: (raw.actor_id as string | null) ?? null,
    parentId: raw.parent_run_id as string,
    rootId: raw.root_run_id as string,
    createdAt: raw.created_at as string,
  };
}

export async function readRevisionRows(
  admin: SupabaseClient,
  rootIds: string[],
): Promise<RevisionRow[] | 'unreadable'> {
  if (rootIds.length === 0) return [];
  const { data, error } = await admin
    .from(TABLE.DEAL_STEP_SKILL_RUNS)
    .select(REVISION_COLUMNS)
    .in('root_run_id', rootIds)
    .order('created_at', { ascending: true });
  if (error) {
    console.error('[skill-revision] revisions could not be read', { code: errorCodeOf(error) });
    return 'unreadable';
  }
  return ((data ?? []) as Record<string, unknown>[]).map(toRow);
}

export function chainOf(root: { id: string; text: string | null }, rows: RevisionRow[]): OutputChain {
  const mine = rows.filter((row) => row.rootId === root.id);
  const versions = root.text === null ? [] : [{ id: root.id, text: root.text }];
  let current = root.id;
  for (let step = 0; step < mine.length && versions.length > 0; step += 1) {
    const next = mine.find(
      (row) => row.parentId === current && row.outcome === 'succeeded' && row.resultText !== null,
    );
    if (!next || next.resultText === null) break;
    versions.push({ id: next.id, text: next.resultText });
    current = next.id;
  }
  return {
    headId: current,
    headText: versions.length > 0 ? versions[versions.length - 1].text : null,
    versions,
    rows: mine,
  };
}

export function summarize(
  chain: OutputChain,
  nameFor: (actorId: string | null) => string,
  sent: ReadonlySet<string> = new Set(),
): RevisionSummary[] {
  return chain.rows.map((row) => {
    const inputs = parseRevisionInputs(row.inputs);
    const parentText = chain.versions.find((version) => version.id === row.parentId)?.text ?? null;
    const position = chain.versions.findIndex((version) => version.id === row.id);
    return {
      id: row.id,
      parentId: row.parentId,
      kind: inputs?.kind ?? 'edits',
      outcome: row.outcome,
      errorMessage: row.errorMessage,
      actorName: nameFor(row.actorId),
      createdAt: row.createdAt,
      version: position === -1 ? null : position + 1,
      edits:
        inputs?.kind === 'edits'
          ? inputs.edits.map((edit) => ({
              id: edit.id,
              kind: edit.kind,
              start: edit.start,
              end: edit.end,
              comment: edit.comment ?? null,
              status: edit.status,
              reason: edit.reason ?? null,
              teach: edit.teach === true,
              sent: sent.has(edit.id),
              resultStart: edit.resultStart ?? null,
              resultEnd: edit.resultEnd ?? null,
              before: parentText === null ? null : parentText.slice(edit.start, edit.end),
            }))
          : [],
      restoredFrom: inputs?.kind === 'restore' ? inputs.restoredFrom : null,
      skillMounted: inputs?.kind === 'edits' ? (inputs.skillMounted ?? null) : null,
    };
  });
}

export async function loadChain(
  admin: SupabaseClient,
  dealStepId: string,
  runId: string,
): Promise<{ root: RootRun; chain: OutputChain } | null | 'unreadable'> {
  const { data, error } = await admin
    .from(TABLE.DEAL_STEP_SKILL_RUNS)
    .select(ROOT_COLUMNS)
    .eq('id', runId)
    .eq('deal_step_id', dealStepId)
    .neq('source', SKILL_RUN_SOURCE.REVISION)
    .maybeSingle();
  if (error) {
    console.error('[skill-revision] revisions could not be read', { code: errorCodeOf(error) });
    return 'unreadable';
  }
  if (!data) return null;
  const raw = data as Record<string, unknown>;
  const rows = await readRevisionRows(admin, [runId]);
  if (rows === 'unreadable') return 'unreadable';
  return {
    root: {
      id: raw.id as string,
      dealStepId: raw.deal_step_id as string,
      skillId: (raw.skill_id as string | null) ?? null,
      versionId: (raw.version_id as string | null) ?? null,
      mountName: (raw.mount_name as string | null) ?? null,
      mountVersion: (raw.mount_version as number | null) ?? null,
      digest: (raw.digest as string | null) ?? null,
      model: (raw.model as string | null) ?? null,
    },
    chain: chainOf({ id: raw.id as string, text: (raw.result_text as string | null) ?? null }, rows),
  };
}
