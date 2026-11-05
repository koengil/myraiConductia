'use client';

import * as React from 'react';

import { postRevision, type PostRevisionResult } from '@/lib/skillRun/revisionClient';
import {
  APPLY_DEADLINE_MS,
  confirmation,
  DID_NOT_FINISH_MESSAGE,
  isOnlyOccurrence,
  outputVersions,
  OUTPUT_CHANGED_MESSAGE,
  reattach,
  settlePending,
  type PendingEdit,
} from '@/lib/skillRun/revisionView';
import type { SkillRunSummary } from '@/lib/skillRun/types';

import { wholeOutputRange } from './wholeOutput';

export type ReviewStatus =
  | { kind: 'idle' }
  | { kind: 'applying'; keys: string[] }
  | { kind: 'done'; message: string }
  | { kind: 'error'; message: string };

export type EditDraft = Pick<PendingEdit, 'kind' | 'start' | 'end' | 'passage' | 'value' | 'teach'> & {
  key?: string;
  headId: string;
};

type Options = {
  runsPath: string;
  run: SkillRunSummary;
  reload: () => Promise<SkillRunSummary[]>;
  pollMs?: number;
  deadlineMs?: number;
};

const HEAD_CONFLICT = 409;

function requestOf(edit: PendingEdit) {
  return edit.kind === 'comment'
    ? {
        kind: 'comment',
        start: edit.start,
        end: edit.end,
        comment: edit.value,
        ...(edit.teach ? { teach: true } : {}),
      }
    : { kind: 'hand', start: edit.start, end: edit.end, text: edit.value };
}

export function useRunRevisions({
  runsPath,
  run,
  reload,
  pollMs = 2000,
  deadlineMs = APPLY_DEADLINE_MS,
}: Options) {
  const [draft, setDraft] = React.useState<{ runId: string; headId: string; edits: PendingEdit[] }>({
    runId: run.id,
    headId: run.headId,
    edits: [],
  });
  const [status, setStatus] = React.useState<ReviewStatus>({ kind: 'idle' });
  const busy = React.useRef(false);
  const alive = React.useRef(true);

  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const pending = React.useMemo(() => {
    if (draft.runId !== run.id) return [];
    if (draft.headId === run.headId) return draft.edits;
    return reattach(draft.edits, run.headText ?? '');
  }, [draft, run.id, run.headId, run.headText]);

  function setEdits(edits: PendingEdit[], headId: string = run.headId) {
    setDraft({
      runId: run.id,
      headId,
      edits: [...edits].sort((a, b) => a.start - b.start),
    });
  }

  function save({ headId, ...edit }: EditDraft) {
    if (headId !== run.headId) {
      setStatus({ kind: 'error', message: OUTPUT_CHANGED_MESSAGE });
      return;
    }
    const key = edit.key ?? crypto.randomUUID();
    const others = pending.filter((entry) => entry.key !== key);
    setEdits([...others, {
        ...edit,
        key,
        problem: null,
        detached: false,
        onlyOccurrence: isOnlyOccurrence(run.headText ?? '', edit.passage),
      }]);
    setStatus({ kind: 'idle' });
  }

  function remove(key: string) {
    setEdits(pending.filter((entry) => entry.key !== key));
  }

  function discard() {
    setEdits([]);
    setStatus({ kind: 'idle' });
  }

  async function landed(revisionId: string, deadline: number) {
    while (alive.current) {
      const fresh = (await reload()).find((entry) => entry.id === run.id);
      const revision = fresh?.revisions.find((entry) => entry.id === revisionId);
      if (fresh && revision) return { fresh, revision };
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return null;
  }

  /** Settles one POST; true only when the next version was recorded. */
  async function finish(result: PostRevisionResult, keys: string[], deadline: number): Promise<boolean> {
    if (result.kind === 'refused') {
      if (result.status === HEAD_CONFLICT) {
        const fresh = (await reload()).find((entry) => entry.id === run.id);
        if (fresh?.headText) {
          const moved = fresh.headId !== run.headId;
          setEdits(moved ? reattach(pending, fresh.headText) : pending, fresh.headId);
        }
      }
      setStatus({ kind: 'error', message: result.message });
      return false;
    }
    const arrived = await landed(result.revisionId, deadline);
    if (!alive.current) return false;
    if (!arrived) {
      setStatus({ kind: 'error', message: DID_NOT_FINISH_MESSAGE });
      return false;
    }
    setEdits(
      settlePending(
        pending,
        keys,
        arrived.revision,
        arrived.fresh.headText ?? '',
        arrived.fresh.headId !== run.headId,
      ),
      arrived.fresh.headId,
    );
    const message = confirmation(arrived.revision, outputVersions(arrived.fresh));
    const succeeded = arrived.revision.outcome === 'succeeded';
    setStatus(succeeded ? { kind: 'done', message } : { kind: 'error', message });
    return succeeded;
  }

  async function send(body: unknown, keys: string[]): Promise<boolean> {
    if (busy.current) return false;
    busy.current = true;
    setStatus({ kind: 'applying', keys });
    const deadline = Date.now() + deadlineMs;
    try {
      return await finish(await postRevision(runsPath, run.id, body), keys, deadline);
    } finally {
      busy.current = false;
    }
  }

  async function apply() {
    const sending = pending.filter((entry) => !entry.detached);
    if (sending.length === 0) return;
    await send(
      { parentId: run.headId, edits: sending.map(requestOf) },
      sending.map((entry) => entry.key),
    );
  }

  /**
   * "What should change?": one comment over the whole output, sent through
   * the same revisions endpoint as a passage comment, so it records the next
   * version (true once recorded). It never teaches the skill: that is
   * the question for Storm "Should revisions also improve the skill?".
   */
  async function reviseWhole(comment: string): Promise<boolean> {
    const text = comment.trim();
    const range = wholeOutputRange(run.headText ?? '');
    if (text === '' || !range) return false;
    return send(
      { parentId: run.headId, edits: [{ kind: 'comment', start: range.start, end: range.end, comment: text }] },
      [],
    );
  }

  async function restore(versionId: string) {
    await send({ parentId: run.headId, restoreOf: versionId }, []);
  }

  return { pending, status, save, remove, discard, apply, restore, reviseWhole };
}

export type RunRevisions = ReturnType<typeof useRunRevisions>;
