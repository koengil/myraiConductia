// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { afterEach, vi } from 'vitest';

import { chainOf, loadChain, readRevisionRows, summarize, type RevisionRow } from '@/lib/skillRun/revisionStore';

import { fakeAdmin } from './helpers/skillRunAdmin';

const ROOT = { id: 'root', text: '# Title\n\nFirst paragraph.' };

function row(overrides: Partial<RevisionRow>): RevisionRow {
  return {
    id: 'rev',
    outcome: 'succeeded',
    inputs: { kind: 'edits', edits: [] },
    resultText: '# Title\n\nSecond paragraph.',
    errorMessage: null,
    actorId: 'user-1',
    parentId: 'root',
    rootId: 'root',
    createdAt: '2026-10-13T10:00:01.000Z',
    ...overrides,
  };
}

const names = (actorId: string | null) => (actorId === 'user-1' ? 'Storm Duncan' : 'Unknown');

describe('chainOf', () => {
  it('is the run itself when nothing has been revised', () => {
    expect(chainOf(ROOT, [])).toEqual({
      headId: 'root',
      headText: ROOT.text,
      versions: [{ id: 'root', text: ROOT.text }],
      rows: [],
    });
  });

  it('follows successful revisions from the run to the head', () => {
    const second = row({ id: 'v2' });
    const third = row({ id: 'v3', parentId: 'v2', resultText: '# Title\n\nThird.' });

    const chain = chainOf(ROOT, [second, third]);

    expect(chain.headId).toBe('v3');
    expect(chain.headText).toBe('# Title\n\nThird.');
    expect(chain.versions.map((version) => version.id)).toEqual(['root', 'v2', 'v3']);
  });

  it('does not move the head for a failed attempt', () => {
    const failed = row({ id: 'f1', outcome: 'failed', resultText: null });

    expect(chainOf(ROOT, [failed]).headId).toBe('root');
  });

  it('ignores the revisions of another run', () => {
    expect(chainOf(ROOT, [row({ id: 'other', rootId: 'elsewhere', parentId: 'elsewhere' })]).rows).toEqual([]);
  });

  it('has no head text for a run that failed', () => {
    expect(chainOf({ id: 'root', text: null }, [])).toEqual({
      headId: 'root',
      headText: null,
      versions: [],
      rows: [],
    });
  });
});

describe('summarize', () => {
  it('numbers versions from the run and reads each passage as it was before the edit', () => {
    const second = row({
      id: 'v2',
      inputs: {
        kind: 'edits',
        skillMounted: true,
        edits: [
          {
            id: 'e1',
            kind: 'comment',
            start: 9,
            end: 25,
            comment: 'Say second.',
            status: 'applied',
            resultStart: 9,
            resultEnd: 26,
          },
        ],
      },
    });

    expect(summarize(chainOf(ROOT, [second]), names)).toEqual([
      {
        id: 'v2',
        parentId: 'root',
        kind: 'edits',
        outcome: 'succeeded',
        errorMessage: null,
        actorName: 'Storm Duncan',
        createdAt: '2026-10-13T10:00:01.000Z',
        version: 2,
        edits: [
          {
            id: 'e1',
            kind: 'comment',
            start: 9,
            end: 25,
            comment: 'Say second.',
            status: 'applied',
            reason: null,
            teach: false,
            sent: false,
            resultStart: 9,
            resultEnd: 26,
            before: 'First paragraph.',
          },
        ],
        restoredFrom: null,
        skillMounted: true,
      },
    ]);
  });

  it('gives a failed attempt no version number and keeps its reason', () => {
    const failed = row({
      id: 'f1',
      outcome: 'failed',
      resultText: null,
      errorMessage: 'The edit could not be applied.',
      inputs: {
        kind: 'edits',
        edits: [{ id: 'e1', kind: 'comment', start: 9, end: 25, comment: 'Fix.', status: 'failed', reason: 'The edit could not be applied.' }],
      },
    });

    const [summary] = summarize(chainOf(ROOT, [failed]), names);

    expect(summary).toMatchObject({ version: null, outcome: 'failed', errorMessage: 'The edit could not be applied.' });
    expect(summary?.edits[0]).toMatchObject({ status: 'failed', reason: 'The edit could not be applied.', before: 'First paragraph.' });
  });

  it('reports which comment edits teach the skill and which were sent', () => {
    const second = row({
      id: 'v2',
      inputs: {
        kind: 'edits',
        edits: [
          { id: 'e1', kind: 'comment', start: 9, end: 25, comment: 'Say second.', teach: true, status: 'applied' },
          { id: 'e2', kind: 'comment', start: 9, end: 25, comment: 'Again.', status: 'applied' },
        ],
      },
    });

    const [sentSummary] = summarize(chainOf(ROOT, [second]), names, new Set(['e1']));
    const [unsentSummary] = summarize(chainOf(ROOT, [second]), names);

    expect(sentSummary?.edits).toMatchObject([{ teach: true, sent: true }, { teach: false, sent: false }]);
    expect(unsentSummary?.edits).toMatchObject([{ teach: true, sent: false }, { teach: false, sent: false }]);
  });

  it('names the version a restore came from', () => {
    const second = row({ id: 'v2' });
    const restore = row({
      id: 'v3',
      parentId: 'v2',
      resultText: ROOT.text,
      inputs: { kind: 'restore', restoredFrom: 'root' },
    });

    const summaries = summarize(chainOf(ROOT, [second, restore]), names);

    expect(summaries[1]).toMatchObject({ kind: 'restore', restoredFrom: 'root', version: 3, edits: [] });
  });
});

describe('reading from the database', () => {
  const STEP = 'step-1';
  const seed = () =>
    fakeAdmin({
      deal_step_skill_runs: [
        { id: 'root', deal_step_id: STEP, source: 'execution', outcome: 'succeeded', result_text: ROOT.text },
      ],
    });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports unreadable instead of no revisions when the revision read fails', async () => {
    const store = seed();
    store.failReadsFrom.add('deal_step_skill_runs');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(await readRevisionRows(store.admin, ['root'])).toBe('unreadable');
    expect(log).toHaveBeenCalledWith('[skill-revision] revisions could not be read', { code: '57014' });
  });

  it('reports unreadable when the run itself cannot be read', async () => {
    const store = seed();
    store.failReadsFrom.add('deal_step_skill_runs:one');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(await loadChain(store.admin, STEP, 'root')).toBe('unreadable');
  });

  it('reports unreadable when only the revisions of the run cannot be read', async () => {
    const store = seed();
    store.failReadsFrom.add('deal_step_skill_runs:many');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(await loadChain(store.admin, STEP, 'root')).toBe('unreadable');
  });

  it('still answers null for a run that is not on the step', async () => {
    expect(await loadChain(seed().admin, 'other-step', 'root')).toBeNull();
  });
});
