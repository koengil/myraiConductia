// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  confirmation,
  DETACHED_PROBLEM,
  normalizeRun,
  outputVersions,
  plural,
  reattach,
  settlePending,
  unsentTaughtCount,
  versionLabel,
  type PendingEdit,
} from '@/lib/skillRun/revisionView';
import type { RevisionEditSummary, RevisionSummary, SkillRunSummary } from '@/lib/skillRun/types';

const TEXT = ['# Memo', '', 'Revenue fell.', '', '- one', '- two'].join('\n');

function revision(overrides: Partial<RevisionSummary> = {}): RevisionSummary {
  return {
    id: 'rev-2',
    parentId: 'run-1',
    kind: 'edits',
    outcome: 'succeeded',
    errorMessage: null,
    actorName: 'Lance Park',
    createdAt: '2026-10-13T10:00:00.000Z',
    version: 2,
    edits: [],
    restoredFrom: null,
    skillMounted: true,
    ...overrides,
  };
}

function run(overrides: Partial<SkillRunSummary> = {}): SkillRunSummary {
  return {
    id: 'run-1',
    outcome: 'succeeded',
    actorName: 'Storm Duncan',
    input: null,
    inputs: {},
    resultText: TEXT,
    errorMessage: null,
    costUsd: null,
    startedAt: null,
    createdAt: '2026-10-13T09:00:00.000Z',
    binding: null,
    model: 'sonnet',
    clampedFrom: null,
    documents: [],
    headId: 'run-1',
    headText: TEXT,
    revisions: [],
    ...overrides,
  };
}

function edit(overrides: Partial<PendingEdit> = {}): PendingEdit {
  return {
    key: 'k1',
    kind: 'comment',
    start: 8,
    end: 21,
    passage: 'Revenue fell.',
    value: 'It rose.',
    teach: false,
    problem: null,
    detached: false,
    onlyOccurrence: true,
    ...overrides,
  };
}

function applied(kind: 'comment' | 'hand', status: 'applied' | 'unresolved', reason: string | null = null) {
  return { id: 'e', kind, start: 0, end: 1, comment: null, status, reason, teach: false, sent: false, resultStart: null, resultEnd: null, before: null };
}

describe('normalizeRun', () => {
  it('treats a run with no revision fields as its own head', () => {
    const { headId, headText, revisions, ...older } = run();

    expect(normalizeRun(older)).toMatchObject({ headId: 'run-1', headText: TEXT, revisions: [] });
    expect([headId, headText, revisions]).toEqual(['run-1', TEXT, []]);
  });
});

describe('outputVersions and versionLabel', () => {
  it('numbers the run as version 1 and each successful revision after it', () => {
    const versions = outputVersions(
      run({
        headId: 'rev-2',
        revisions: [revision(), revision({ id: 'failed', version: null, outcome: 'failed' })],
      }),
    );

    expect(versions.map((version) => [version.id, version.number, version.actorName])).toEqual([
      ['run-1', 1, 'Storm Duncan'],
      ['rev-2', 2, 'Lance Park'],
    ]);
    expect(versionLabel(versions, 'rev-2')).toBe('Version 2 of 2');
  });

  it('has no versions for a run that failed', () => {
    expect(outputVersions(run({ resultText: null, headText: null, outcome: 'failed' }))).toEqual([]);
  });
});

describe('plural', () => {
  it('adds an s to anything but one', () => {
    expect([plural(1, 'edit'), plural(3, 'edit'), plural(0, 'edit')]).toEqual(['1 edit', '3 edits', '0 edits']);
  });
});

describe('confirmation', () => {
  const versions = outputVersions(run({ revisions: [revision()] }));

  it('states what was applied, what was not, and the version recorded', () => {
    const landed = revision({
      edits: [applied('comment', 'applied'), applied('hand', 'applied'), applied('comment', 'applied'), applied('comment', 'unresolved', 'No source.')],
    });

    expect(confirmation(landed, versions)).toBe('3 edits applied. 1 could not be applied. Version 2 is recorded.');
  });

  it('says nothing about failures when every edit was applied', () => {
    expect(confirmation(revision({ edits: [applied('hand', 'applied')] }), versions)).toBe(
      '1 edit applied. Version 2 is recorded.',
    );
  });

  it('names the version a restore brought back', () => {
    expect(confirmation(revision({ kind: 'restore', restoredFrom: 'run-1' }), versions)).toBe(
      'Version 1 restored. Version 2 is recorded.',
    );
  });

  it('gives the reason of a failed attempt', () => {
    expect(
      confirmation(revision({ outcome: 'failed', version: null, errorMessage: 'None of the comments could be applied.' }), versions),
    ).toBe('None of the comments could be applied.');
  });
});

describe('reattach', () => {
  it('keeps an edit whose passage is where it was', () => {
    expect(reattach([edit()], TEXT)).toEqual([edit()]);
  });

  it('moves an edit whose passage shifted but is unchanged', () => {
    const shifted = ['# A longer memo title', '', 'Revenue fell.', '', '- one', '- two'].join('\n');

    expect(reattach([edit()], shifted)).toEqual([edit({ start: 23, end: 36 })]);
  });

  it('detaches an edit whose passage no longer exists', () => {
    const rewritten = ['# Memo', '', 'Revenue rose.', '', '- one', '- two'].join('\n');

    expect(reattach([edit()], rewritten)).toEqual([edit({ detached: true, problem: DETACHED_PROBLEM })]);
  });

  it('detaches an edit whose paragraph grew around the same text', () => {
    const grown = ['# Memo', '', 'Revenue fell. Costs rose.', '', '- one', '- two'].join('\n');

    expect(reattach([edit()], grown)).toEqual([edit({ detached: true, problem: DETACHED_PROBLEM })]);
  });

  it('detaches an edit whose list item grew around the same text', () => {
    const grown = ['# Memo', '', 'Revenue fell.', '', '- one more', '- two'].join('\n');
    const item = edit({ start: 23, end: 28, passage: '- one' });

    expect(reattach([item], grown)).toEqual([{ ...item, detached: true, problem: DETACHED_PROBLEM }]);
  });

  it('detaches an edit whose passage now appears twice', () => {
    const doubled = ['Revenue fell.', '', 'Revenue fell.'].join('\n');

    expect(reattach([edit({ start: 100, end: 113 })], doubled)[0]).toMatchObject({ detached: true });
  });
});

describe('reattach and identical blocks', () => {
  const twinsBefore = 'Intro.\n\n- TBD\n- TBD';

  function twin(nth: number, before: string): PendingEdit {
    const at = nth === 0 ? before.indexOf('- TBD') : before.lastIndexOf('- TBD');
    return edit({ start: at, end: at + 5, passage: '- TBD', onlyOccurrence: false });
  }

  it('detaches an edit on a repeated block when the other copy is rewritten instead of following it', () => {
    const after = 'Intro.\n\n- TBD\n- Done';

    expect(reattach([twin(1, twinsBefore)], after)[0]).toMatchObject({ detached: true, problem: DETACHED_PROBLEM });
  });

  it('detaches an edit on a repeated block when earlier text shrinks by the twin spacing', () => {
    const before = 'A long intro.\n\n- TBD\n- TBD';
    const after = 'A intro\n\n- TBD\n- TBD';

    expect(reattach([twin(0, before)], after)[0]).toMatchObject({ detached: true });
  });

  it('follows a unique passage that moved and records that it is still the only one', () => {
    const shifted = ['# A longer memo title', '', 'Revenue fell.', '', '- one', '- two'].join('\n');

    expect(reattach([edit()], shifted)).toEqual([edit({ start: 23, end: 36 })]);
  });

  it('keeps a unique passage that did not move', () => {
    expect(reattach([edit()], TEXT)).toEqual([edit()]);
  });

  it('does not count a passage inside a longer block as an occurrence', () => {
    const longer = ['# Memo', '', 'Revenue fell.', '', '- one', '- one more'].join('\n');
    const item = edit({ start: 23, end: 28, passage: '- one' });

    expect(reattach([item], longer)).toEqual([item]);
  });

  it('clears the detached message when an edit is placed again, and keeps an unresolved reason', () => {
    const detached = edit({ detached: true, problem: DETACHED_PROBLEM });
    const unresolved = edit({ key: 'k2', start: 23, end: 28, passage: '- one', problem: 'No source.' });

    expect(reattach([detached, unresolved], TEXT)).toEqual([
      edit(),
      edit({ key: 'k2', start: 23, end: 28, passage: '- one', problem: 'No source.' }),
    ]);
  });

  it('leaves an edit on a repeated block alone when the head did not move', () => {
    const doubled = ['Revenue fell.', '', 'Revenue fell.'].join('\n');
    const pending = [edit({ start: 15, end: 28, onlyOccurrence: false })];
    const failed = revision({ outcome: 'failed', version: null, edits: [] });

    expect(settlePending(pending, ['gone'], failed, doubled, false)).toEqual(pending);
  });
});

describe('settlePending', () => {
  it('drops the edits that were applied and keeps an unresolved one with its reason', () => {
    const pending = [edit({ key: 'a' }), edit({ key: 'b', start: 23, end: 28, passage: '- one', value: 'Name it.' })];
    const landed = revision({
      edits: [applied('comment', 'applied'), applied('comment', 'unresolved', 'No document names the buyer.')],
    });
    const head = ['# Memo', '', 'Revenue rose 12%.', '', '- one', '- two'].join('\n');

    expect(settlePending(pending, ['a', 'b'], landed, head, true)).toEqual([
      edit({ key: 'b', start: 27, end: 32, passage: '- one', value: 'Name it.', problem: 'No document names the buyer.' }),
    ]);
  });

  it('keeps every edit when the attempt failed', () => {
    const pending = [edit({ key: 'a' })];

    expect(settlePending(pending, ['a'], revision({ outcome: 'failed', version: null }), TEXT, false)).toEqual(pending);
  });

  it('keeps an edit that was not part of the batch', () => {
    const pending = [edit({ key: 'a' }), edit({ key: 'late', start: 29, end: 34, passage: '- two' })];
    const landed = revision({ edits: [applied('hand', 'applied')] });

    expect(settlePending(pending, ['a'], landed, TEXT, true).map((entry) => entry.key)).toEqual(['late']);
  });

  it('gives a failed attempt each unresolved reason and keeps the edit', () => {
    const pending = [edit({ key: 'a' })];
    const failed = revision({
      outcome: 'failed',
      version: null,
      edits: [applied('comment', 'unresolved', 'No document names the buyer.')],
    });

    expect(settlePending(pending, ['a'], failed, TEXT, false)).toEqual([
      edit({ key: 'a', problem: 'No document names the buyer.' }),
    ]);
  });

  it('re-attaches the edits of a failed attempt that lost a race against a moved head', () => {
    const pending = [
      edit({ key: 'a' }),
      edit({ key: 'b', start: 23, end: 28, passage: '- one', value: 'Name it.' }),
    ];
    const failed = revision({ outcome: 'failed', version: null, edits: [] });
    const moved = ['# A longer memo title', '', 'Revenue fell.', '', '- uno', '- two'].join('\n');

    expect(settlePending(pending, ['a', 'b'], failed, moved, true)).toEqual([
      edit({ key: 'a', start: 23, end: 36 }),
      edit({ key: 'b', start: 23, end: 28, passage: '- one', value: 'Name it.', detached: true, problem: DETACHED_PROBLEM }),
    ]);
  });
});

describe('unsentTaughtCount', () => {
  function taught(id: string, overrides: Partial<RevisionEditSummary> = {}): RevisionEditSummary {
    return {
      id,
      kind: 'comment',
      start: 0,
      end: 1,
      comment: 'Lead with the plan',
      status: 'applied',
      reason: null,
      teach: true,
      sent: false,
      resultStart: 0,
      resultEnd: 1,
      before: null,
      ...overrides,
    };
  }

  it('counts applied, taught comments not yet sent', () => {
    const summary = run({
      revisions: [revision({ edits: [taught('a'), taught('b'), taught('c', { sent: true }), taught('d')] })],
    });

    expect(unsentTaughtCount(summary)).toBe(3);
  });

  it('ignores untaught, unresolved and hand edits, and failed revisions', () => {
    const summary = run({
      revisions: [
        revision({
          edits: [
            taught('a', { teach: false }),
            taught('b', { status: 'unresolved' }),
            taught('c', { kind: 'hand' }),
          ],
        }),
        revision({ id: 'rev-3', outcome: 'failed', edits: [taught('d')] }),
      ],
    });

    expect(unsentTaughtCount(summary)).toBe(0);
  });

  it('still counts an applied comment after an earlier version is restored', () => {
    const summary = run({
      revisions: [
        revision({ edits: [taught('a')] }),
        revision({ id: 'rev-3', kind: 'restore', restoredFrom: 'run-1', version: 3, edits: [] }),
      ],
    });

    expect(unsentTaughtCount(summary)).toBe(1);
  });
});
