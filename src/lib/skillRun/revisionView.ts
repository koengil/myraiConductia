import { blockRanges, isAligned, type Block, type Range } from './blocks';
import type { RevisionSummary, SkillRunSummary } from './types';

export const DETACHED_PROBLEM = 'This passage changed. Place the edit again or remove it.';
export const OUTPUT_CHANGED_MESSAGE =
  'The output changed while you were editing. Select the passage again.';
export const NOT_APPLIED_MESSAGE = 'The edits could not be applied.';
export const DID_NOT_FINISH_MESSAGE = 'The edit did not finish. Nothing was changed. Your edits are kept.';
export const APPLY_DEADLINE_MS = 330_000;

export type OutputVersion = {
  id: string;
  number: number;
  actorName: string;
  createdAt: string;
  revision: RevisionSummary | null;
};

export type PendingEdit = {
  key: string;
  kind: 'comment' | 'hand';
  start: number;
  end: number;
  passage: string;
  value: string;
  teach: boolean;
  problem: string | null;
  detached: boolean;
  onlyOccurrence: boolean;
};

type RunAsListed = Omit<SkillRunSummary, 'headId' | 'headText' | 'revisions'> &
  Partial<Pick<SkillRunSummary, 'headId' | 'headText' | 'revisions'>>;

export function normalizeRun(run: RunAsListed): SkillRunSummary {
  return {
    ...run,
    headId: run.headId ?? run.id,
    headText: run.headText === undefined ? run.resultText : run.headText,
    revisions: run.revisions ?? [],
  };
}

export function outputVersions(run: SkillRunSummary): OutputVersion[] {
  if (run.resultText === null) return [];
  const later = run.revisions
    .flatMap((revision) => (revision.version === null ? [] : [{ revision, number: revision.version }]))
    .sort((a, b) => a.number - b.number)
    .map(({ revision, number }) => ({
      id: revision.id,
      number,
      actorName: revision.actorName,
      createdAt: revision.createdAt,
      revision,
    }));
  return [
    { id: run.id, number: 1, actorName: run.actorName, createdAt: run.createdAt, revision: null },
    ...later,
  ];
}

export function versionLabel(versions: OutputVersion[], id: string): string {
  const version = versions.find((entry) => entry.id === id);
  return `Version ${String(version?.number ?? versions.length)} of ${String(versions.length)}`;
}

export function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

export function confirmation(revision: RevisionSummary, versions: OutputVersion[]): string {
  if (revision.outcome === 'failed') return revision.errorMessage ?? NOT_APPLIED_MESSAGE;
  const recorded = `Version ${String(revision.version ?? versions.length)} is recorded.`;
  if (revision.kind === 'restore') {
    const source = versions.find((entry) => entry.id === revision.restoredFrom);
    return `Version ${String(source?.number ?? 1)} restored. ${recorded}`;
  }
  const applied = revision.edits.filter((edit) => edit.status === 'applied').length;
  const missed = revision.edits.length - applied;
  const parts = [`${plural(applied, 'edit')} applied.`];
  if (missed > 0) parts.push(`${String(missed)} could not be applied.`);
  return [...parts, recorded].join(' ');
}

export function occurrencesOf(headText: string, blocks: Block[], passage: string): Range[] {
  const found: Range[] = [];
  if (passage === '') return found;
  for (let at = headText.indexOf(passage); at !== -1; at = headText.indexOf(passage, at + 1)) {
    const range = { start: at, end: at + passage.length };
    if (isAligned(blocks, range)) found.push(range);
  }
  return found;
}

export function isOnlyOccurrence(headText: string, passage: string): boolean {
  return occurrencesOf(headText, blockRanges(headText), passage).length === 1;
}

export function reattach(edits: PendingEdit[], headText: string): PendingEdit[] {
  const blocks = blockRanges(headText);
  return edits.map((edit) => {
    const found = edit.onlyOccurrence ? occurrencesOf(headText, blocks, edit.passage) : [];
    if (found.length !== 1) return { ...edit, detached: true, problem: DETACHED_PROBLEM };
    return {
      ...edit,
      ...found[0],
      detached: false,
      problem: edit.problem === DETACHED_PROBLEM ? null : edit.problem,
    };
  });
}

export function settlePending(
  edits: PendingEdit[],
  sentKeys: string[],
  revision: RevisionSummary,
  headText: string,
  headMoved: boolean,
): PendingEdit[] {
  const failed = revision.outcome === 'failed';
  const kept = edits.flatMap((edit) => {
    const position = sentKeys.indexOf(edit.key);
    if (position === -1) return [edit];
    const outcome = revision.edits[position];
    if (failed) {
      if (outcome?.status !== 'unresolved') return [edit];
      return [{ ...edit, problem: outcome.reason ?? NOT_APPLIED_MESSAGE }];
    }
    if (!outcome || outcome.status === 'applied') return [];
    return [{ ...edit, problem: outcome.reason ?? NOT_APPLIED_MESSAGE }];
  });
  return headMoved ? reattach(kept, headText) : kept;
}

export function unsentTaughtCount(run: SkillRunSummary): number {
  return run.revisions
    .filter((revision) => revision.outcome === 'succeeded')
    .flatMap((revision) => revision.edits)
    .filter((edit) => edit.kind === 'comment' && edit.teach && !edit.sent && edit.status === 'applied').length;
}
