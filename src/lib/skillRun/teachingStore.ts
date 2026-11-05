import type { SupabaseClient } from '@supabase/supabase-js';

import { TABLE } from '@/lib/constants/tables';
import { errorCodeOf } from '@/lib/errors/upstream';

import { loadChain, type RevisionRow } from './revisionStore';
import { parseRevisionInputs } from './revisions';
import { promptRoom, teachableComments, teachingPrompt } from './teaching';

export type TeachingRow = {
  revisionId: string;
  editId: string;
  draftId: string;
  kind: 'waiting' | 'sent';
};

const TEACHING_COLUMNS = 'revision_run_id, edit_id, draft_id, kind';

function taughtRevisionIds(rows: readonly RevisionRow[]): string[] {
  return rows
    .filter((row) => {
      const inputs = parseRevisionInputs(row.inputs);
      return inputs?.kind === 'edits' && inputs.edits.some((edit) => edit.teach === true);
    })
    .map((row) => row.id);
}

export async function readTeachings(
  admin: SupabaseClient,
  revisionRows: readonly RevisionRow[],
): Promise<TeachingRow[] | 'unreadable'> {
  const revisionIds = taughtRevisionIds(revisionRows);
  if (revisionIds.length === 0) return [];
  const { data, error } = await admin
    .from(TABLE.SKILL_COMMENT_TEACHINGS)
    .select(TEACHING_COLUMNS)
    .in('revision_run_id', revisionIds);
  if (error) {
    console.error('[skill-teaching] teachings could not be read', { code: errorCodeOf(error) });
    return 'unreadable';
  }
  return ((data ?? []) as Record<string, unknown>[]).map((raw) => ({
    revisionId: raw.revision_run_id as string,
    editId: raw.edit_id as string,
    draftId: raw.draft_id as string,
    kind: raw.kind as TeachingRow['kind'],
  }));
}

export function sentEditIds(rows: readonly TeachingRow[]): Set<string> {
  return new Set(rows.filter((row) => row.kind === 'sent').map((row) => row.editId));
}

export type TeachingOffer = { edits: { runId: string; editId: string }[]; prompt: string };

export async function prepareTeachingOffer(
  admin: SupabaseClient,
  input: { dealStepId: string; seedRunId: string; draftId: string },
): Promise<TeachingOffer | null | 'unreadable'> {
  const loaded = await loadChain(admin, input.dealStepId, input.seedRunId);
  if (loaded === 'unreadable') return 'unreadable';
  if (!loaded) return null;
  const { chain } = loaded;

  const rows = await readTeachings(admin, chain.rows);
  if (rows === 'unreadable') return 'unreadable';

  const { data, error } = await admin
    .from(TABLE.SKILL_AUTHORING_DRAFTS)
    .select('composer_text')
    .eq('id', input.draftId)
    .maybeSingle();
  if (error) {
    console.error('[skill-teaching] composer could not be read', { code: errorCodeOf(error) });
    return 'unreadable';
  }
  const composerText = (data as { composer_text?: unknown } | null)?.composer_text;
  if (typeof composerText !== 'string') return 'unreadable';

  const waiting = new Set(
    rows.filter((row) => row.kind === 'waiting' && row.draftId === input.draftId).map((row) => row.editId),
  );
  const open = teachableComments(chain, sentEditIds(rows)).filter((item) => !waiting.has(item.editId));
  const { text, included } = teachingPrompt(open, promptRoom(composerText));
  if (included.length === 0) return null;
  return {
    edits: included.map((item) => ({ runId: item.revisionId, editId: item.editId })),
    prompt: text,
  };
}
