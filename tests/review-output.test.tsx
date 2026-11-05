import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, beforeAll, afterAll } from 'vitest';

import { RunOutput } from '@/components/rail/review/RunOutput';
import { useRunRevisions } from '@/components/rail/review/useRunRevisions';
import { blockRanges, isAligned } from '@/lib/skillRun/blocks';
import type { RevisionEditSummary, RevisionSummary, SkillRunSummary } from '@/lib/skillRun/types';
import { MotionGlobalConfig } from 'framer-motion';

// Overlay exits finish at once, so a test awaits a close without running the
// real 180 ms motion. tests/overlay/dialog.test.tsx keeps the exit on real motion.
beforeAll(() => {
  MotionGlobalConfig.skipAnimations = true;
});
afterAll(() => {
  MotionGlobalConfig.skipAnimations = false;
});

const RUNS_PATH = '/api/v1/deals/ATLAS-2026-001/steps/custom%3Astep/skill-runs';
const RUN_ID = '3f0d6f9a-1f4c-4a2f-9f37-2f8f2c0f6f11';
const TEXT = ['# Memo', '', 'Revenue fell.', '', '- one', '- two'].join('\n');
const DETACHED = 'This passage changed. Place the edit again or remove it.';
const OUTPUT_CHANGED = 'The output changed while you were editing. Select the passage again.';
const HEAD_MOVED = 'This output changed while you were editing. Your edits are kept. Check them against the new version.';

function run(overrides: Partial<SkillRunSummary> = {}): SkillRunSummary {
  return {
    id: RUN_ID,
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
    headId: RUN_ID,
    headText: TEXT,
    revisions: [],
    ...overrides,
  };
}

function editSummary(overrides: Partial<RevisionEditSummary> = {}): RevisionEditSummary {
  return {
    id: 'e1',
    kind: 'comment',
    start: 8,
    end: 21,
    comment: 'It rose 12%.',
    status: 'applied',
    reason: null,
    teach: false,
    sent: false,
    resultStart: 8,
    resultEnd: 25,
    before: 'Revenue fell.',
    ...overrides,
  };
}

function revision(overrides: Partial<RevisionSummary> = {}): RevisionSummary {
  return {
    id: 'rev-2',
    parentId: RUN_ID,
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

const server = {
  posts: [] as { url: string; body: unknown }[],
  reply: (): Response | Promise<Response> => new Response('{}', { status: 500 }),
  lists: [] as SkillRunSummary[][],
};

function Harness({ initial, onTeach }: { initial: SkillRunSummary; onTeach?: () => void }) {
  const [runs, setRuns] = React.useState([initial]);
  const reload = React.useCallback(async () => {
    const next = server.lists.length > 1 ? (server.lists.shift() ?? [initial]) : (server.lists[0] ?? [initial]);
    setRuns(next);
    return next;
  }, [initial]);
  return <RunOutput runsPath={RUNS_PATH} run={runs[0]} documents={[]} reload={reload} pollMs={1} onTeach={onTeach} />;
}

function openReview(initial: SkillRunSummary = run(), onTeach?: () => void) {
  render(<Harness initial={initial} onTeach={onTeach} />);
  fireEvent.click(screen.getByRole('button', { name: 'Review output' }));
  return screen.getByRole('dialog', { name: 'Review output' });
}

function output(dialog: HTMLElement) {
  return within(within(dialog).getByRole('group', { name: 'Output' }));
}

function addComment(dialog: HTMLElement, passage: string, comment: string) {
  fireEvent.click(output(dialog).getByText(passage));
  fireEvent.change(within(dialog).getByLabelText('What should change in this passage'), {
    target: { value: comment },
  });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Add comment' }));
}

describe('reviewing a run output', () => {
  beforeEach(() => {
    server.posts = [];
    server.reply = () => new Response('{}', { status: 500 });
    server.lists = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          server.posts.push({ url, body: JSON.parse(String(init.body)) });
          return server.reply();
        }
        return new Response(JSON.stringify({ id: 'x', text: 'Fetched version text.' }), { status: 200 });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('labels the output with its version and who made it', () => {
    render(<Harness initial={run()} />);

    expect(screen.getByText(/Version 1 of 1 · Storm Duncan/)).toBeInTheDocument();
  });

  it('offers Teach the skill with the count of applied comments not yet sent', () => {
    const onTeach = vi.fn();
    const taught = (id: string) => editSummary({ id, teach: true, sent: false });
    render(
      <Harness
        initial={run({
          headId: 'rev-2',
          revisions: [revision({ edits: [taught('e1'), taught('e2')] })],
        })}
        onTeach={onTeach}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Teach the skill · 2 comments' }));

    expect(onTeach).toHaveBeenCalledTimes(1);
  });

  it('hides Teach the skill when every taught comment was sent, or when there is no onTeach', () => {
    const sent = run({
      headId: 'rev-2',
      revisions: [revision({ edits: [editSummary({ teach: true, sent: true })] })],
    });
    const unsent = run({
      headId: 'rev-2',
      revisions: [revision({ edits: [editSummary({ teach: true, sent: false })] })],
    });

    const { unmount } = render(<Harness initial={sent} onTeach={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /Teach the skill/ })).not.toBeInTheDocument();
    unmount();

    render(<Harness initial={unsent} />);
    expect(screen.queryByRole('button', { name: /Teach the skill/ })).not.toBeInTheDocument();
  });

  it('adds a comment on a selected passage and names the commit for what it does', () => {
    const dialog = openReview();

    addComment(dialog, 'Revenue fell.', 'It rose 12%.');

    expect(within(dialog).getByRole('list', { name: 'Pending' })).toHaveTextContent('It rose 12%.');
    expect(within(dialog).getByRole('button', { name: 'Apply 1 edit' })).toBeEnabled();
    expect(output(dialog).getByText('Revenue fell.')).toHaveAttribute('data-mark', 'pending');
  });

  it('reopens a pending edit when its passage is selected again', () => {
    const dialog = openReview();
    addComment(dialog, 'Revenue fell.', 'It rose 12%.');

    fireEvent.click(output(dialog).getByText('Revenue fell.'));

    expect(within(dialog).getByLabelText('What should change in this passage')).toHaveValue('It rose 12%.');
    expect(within(dialog).getByRole('button', { name: 'Update comment' })).toBeInTheDocument();
  });

  it('applies a hand edit and states what was recorded', async () => {
    const next = ['# Memo', '', 'Revenue rose.', '', '- one', '- two'].join('\n');
    server.reply = () => new Response(JSON.stringify({ revisionId: 'rev-2' }), { status: 201 });
    server.lists = [
      [
        run({
          headId: 'rev-2',
          headText: next,
          revisions: [revision({ edits: [editSummary({ kind: 'hand', comment: null, resultEnd: 21 })] })],
        }),
      ],
    ];
    const dialog = openReview();

    fireEvent.click(output(dialog).getByText('Revenue fell.'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Edit text' }));
    const field = within(dialog).getByLabelText('Passage text, in Markdown');
    expect(field).toHaveValue('Revenue fell.');
    fireEvent.change(field, { target: { value: 'Revenue rose.' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save edit' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply 1 edit' }));

    expect(await within(dialog).findByText('1 edit applied. Version 2 is recorded.')).toBeInTheDocument();
    expect(server.posts).toEqual([
      {
        url: `${RUNS_PATH}/${RUN_ID}/revisions`,
        body: { parentId: RUN_ID, edits: [{ kind: 'hand', start: 8, end: 21, text: 'Revenue rose.' }] },
      },
    ]);
    expect(within(dialog).getByText('Version 2 of 2')).toBeInTheDocument();
    expect(output(dialog).getByText('Revenue rose.')).toHaveAttribute('data-mark', 'hand');
    expect(within(dialog).getByRole('list', { name: 'Changed in this version' })).toHaveTextContent('Edited by hand');
    expect(within(dialog).getByRole('button', { name: 'Apply edits' })).toBeDisabled();
  });

  it('waits for a comment batch and keeps an unresolved comment with its reason', async () => {
    const next = ['# Memo', '', 'Revenue rose 12%.', '', '- one', '- two'].join('\n');
    server.reply = () => new Response(JSON.stringify({ revisionId: 'rev-2' }), { status: 202 });
    server.lists = [
      [run()],
      [
        run({
          headId: 'rev-2',
          headText: next,
          revisions: [
            revision({
              edits: [
                editSummary(),
                editSummary({
                  id: 'e2',
                  start: 23,
                  end: 28,
                  comment: 'Name the buyer.',
                  status: 'unresolved',
                  reason: 'No document names the buyer.',
                  resultStart: null,
                  resultEnd: null,
                  before: '- one',
                }),
              ],
            }),
          ],
        }),
      ],
    ];
    const dialog = openReview();
    addComment(dialog, 'Revenue fell.', 'It rose 12%.');
    addComment(dialog, 'one', 'Name the buyer.');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply 2 edits' }));

    expect(
      await within(dialog).findByText('1 edit applied. 1 could not be applied. Version 2 is recorded.'),
    ).toBeInTheDocument();
    expect(server.posts[0]?.body).toEqual({
      parentId: RUN_ID,
      edits: [
        { kind: 'comment', start: 8, end: 21, comment: 'It rose 12%.' },
        { kind: 'comment', start: 23, end: 28, comment: 'Name the buyer.' },
      ],
    });
    const pending = within(dialog).getByRole('list', { name: 'Pending' });
    expect(pending).toHaveTextContent('Not applied');
    expect(pending).toHaveTextContent('No document names the buyer.');
    expect(output(dialog).getByText('Revenue rose 12%.')).toHaveAttribute('data-mark', 'comment');
  });

  it('says it is applying and locks the document while a batch is in flight', () => {
    server.reply = () => new Promise<Response>(() => undefined);
    const dialog = openReview();
    addComment(dialog, 'Revenue fell.', 'It rose 12%.');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply 1 edit' }));
    fireEvent.click(output(dialog).getByText('one'));

    expect(within(dialog).getByText('Applying. This can take a minute.')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Add comment' })).not.toBeInTheDocument();
    expect(output(dialog).getByText('Revenue fell.')).toHaveAttribute('data-mark', 'applying');
  });

  it('keeps the pending edits when the output changed underneath', async () => {
    server.reply = () => new Response(JSON.stringify({ error: HEAD_MOVED }), { status: 409 });
    server.lists = [[run()]];
    const dialog = openReview();
    addComment(dialog, 'Revenue fell.', 'It rose 12%.');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply 1 edit' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(HEAD_MOVED);
    expect(within(dialog).getByRole('list', { name: 'Pending' })).toHaveTextContent('It rose 12%.');
  });

  it('lists an edit as detached and does not send it when the head moves and its passage is gone', () => {
    const moved = ['# Memo', '', 'Revenue rose.', '', '- one', '- two'].join('\n');
    const reload = vi.fn(async () => [run()]);
    const view = render(<RunOutput runsPath={RUNS_PATH} run={run()} documents={[]} reload={reload} pollMs={1} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review output' }));
    addComment(screen.getByRole('dialog', { name: 'Review output' }), 'Revenue fell.', 'It rose 12%.');

    view.rerender(
      <RunOutput
        runsPath={RUNS_PATH}
        run={run({ headId: 'rev-2', headText: moved, revisions: [revision()] })}
        documents={[]}
        reload={reload}
        pollMs={1}
      />,
    );

    const dialog = screen.getByRole('dialog', { name: 'Review output' });
    expect(within(dialog).getByText(DETACHED)).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /^Apply \d+ edit/ })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /^Apply/ })).toBeDisabled();
    expect(server.posts).toHaveLength(0);
  });

  it('closes a composer left open when the head moves under it and saves nothing', () => {
    const moved = ['# Memo', '', 'Revenue rose.', '', '- one', '- two'].join('\n');
    const reload = vi.fn(async () => [run()]);
    const view = render(<RunOutput runsPath={RUNS_PATH} run={run()} documents={[]} reload={reload} pollMs={1} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review output' }));
    const dialog = screen.getByRole('dialog', { name: 'Review output' });
    fireEvent.click(output(dialog).getByText('Revenue fell.'));
    fireEvent.change(within(dialog).getByLabelText('What should change in this passage'), {
      target: { value: 'Typed before the head moved.' },
    });

    view.rerender(
      <RunOutput
        runsPath={RUNS_PATH}
        run={run({ headId: 'rev-2', headText: moved, revisions: [revision()] })}
        documents={[]}
        reload={reload}
        pollMs={1}
      />,
    );

    expect(within(dialog).queryByRole('button', { name: 'Add comment' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('list', { name: 'Pending' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Review output' })).toBeInTheDocument();
  });

  it('closes a composer reopened on a pending edit when that edit re-anchors', () => {
    const shifted = ['# A longer memo title', '', 'Revenue fell.', '', '- one', '- two'].join('\n');
    const reload = vi.fn(async () => [run()]);
    const view = render(<RunOutput runsPath={RUNS_PATH} run={run()} documents={[]} reload={reload} pollMs={1} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review output' }));
    const dialog = screen.getByRole('dialog', { name: 'Review output' });
    addComment(dialog, 'Revenue fell.', 'It rose 12%.');
    fireEvent.click(output(dialog).getByText('Revenue fell.'));
    expect(within(dialog).getByRole('button', { name: 'Update comment' })).toBeInTheDocument();

    view.rerender(
      <RunOutput
        runsPath={RUNS_PATH}
        run={run({ headId: 'rev-2', headText: shifted, revisions: [revision()] })}
        documents={[]}
        reload={reload}
        pollMs={1}
      />,
    );

    expect(within(dialog).queryByLabelText('What should change in this passage')).not.toBeInTheDocument();
    expect(within(within(dialog).getByRole('list', { name: 'Pending' })).getAllByRole('listitem')).toHaveLength(1);
  });

  it('shows the whole comment of a detached edit so it can be read back', () => {
    const moved = ['# Memo', '', 'Revenue rose.', '', '- one', '- two'].join('\n');
    const comment = `${'Explain the drop in revenue against the prior quarter. '.repeat(3)}Then name the buyer.`;
    const reload = vi.fn(async () => [run()]);
    const view = render(<RunOutput runsPath={RUNS_PATH} run={run()} documents={[]} reload={reload} pollMs={1} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review output' }));
    addComment(screen.getByRole('dialog', { name: 'Review output' }), 'Revenue fell.', comment);

    view.rerender(
      <RunOutput
        runsPath={RUNS_PATH}
        run={run({ headId: 'rev-2', headText: moved, revisions: [revision()] })}
        documents={[]}
        reload={reload}
        pollMs={1}
      />,
    );

    const pending = within(screen.getByRole('dialog', { name: 'Review output' })).getByRole('list', {
      name: 'Pending',
    });
    expect(pending).toHaveTextContent(comment);
  });

  it('keeps the view open when a press inside the panel is released on the backdrop', () => {
    const dialog = openReview();
    const backdrop = dialog.parentElement as HTMLElement;

    fireEvent.mouseDown(within(dialog).getByRole('heading', { name: 'Review output' }));
    fireEvent.click(backdrop);

    expect(screen.getByRole('dialog', { name: 'Review output' })).toBeInTheDocument();
  });

  it('closes the view when the backdrop is pressed and released', async () => {
    const dialog = openReview();
    const backdrop = dialog.parentElement as HTMLElement;

    fireEvent.mouseDown(backdrop);
    fireEvent.click(backdrop);

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Review output' })).not.toBeInTheDocument(),
    );
  });

  it('shows an earlier version read-only and restores it', async () => {
    server.reply = () => new Response(JSON.stringify({ revisionId: 'rev-3' }), { status: 201 });
    server.lists = [
      [
        run({
          headId: 'rev-3',
          headText: TEXT,
          revisions: [
            revision(),
            revision({ id: 'rev-3', parentId: 'rev-2', kind: 'restore', version: 3, restoredFrom: RUN_ID }),
          ],
        }),
      ],
    ];
    const dialog = openReview(run({ headId: 'rev-2', headText: 'Second output.', revisions: [revision()] }));

    fireEvent.click(within(dialog).getByRole('button', { name: 'Earlier version' }));

    expect(within(dialog).getByText('Version 1 of 2')).toBeInTheDocument();
    expect(within(dialog).getByText('This is an earlier version. It is read-only.')).toBeInTheDocument();
    fireEvent.click(output(dialog).getByText('Revenue fell.'));
    expect(within(dialog).queryByRole('button', { name: 'Add comment' })).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore this version' }));

    expect(await within(dialog).findByText('Version 1 restored. Version 3 is recorded.')).toBeInTheDocument();
    expect(server.posts[0]?.body).toEqual({ parentId: 'rev-2', restoreOf: RUN_ID });
    expect(within(dialog).getByText('Version 3 of 3')).toBeInTheDocument();
  });

  it('shows the passage as it was before an edit', () => {
    const dialog = openReview(
      run({
        headId: 'rev-2',
        headText: ['# Memo', '', 'Revenue rose 12%.', '', '- one', '- two'].join('\n'),
        revisions: [revision({ edits: [editSummary()] })],
      }),
    );
    const changed = within(dialog).getByRole('list', { name: 'Changed in this version' });

    fireEvent.click(within(changed).getByRole('button', { name: 'Show before' }));

    expect(within(changed).getByText('Revenue fell.')).toBeInTheDocument();
    expect(changed).toHaveTextContent('It rose 12%.');
    expect(changed).toHaveTextContent('Lance Park');
  });

  it('reaches a passage from the keyboard', () => {
    const dialog = openReview();
    const heading = within(dialog).getByRole('heading', { name: 'Memo' });
    expect(heading).toHaveAttribute('tabindex', '0');
    heading.focus();

    fireEvent.keyDown(heading, { key: 'ArrowDown' });
    const paragraph = output(dialog).getByText('Revenue fell.');
    expect(paragraph).toHaveFocus();
    fireEvent.keyDown(paragraph, { key: 'Enter' });

    expect(within(dialog).getByLabelText('What should change in this passage')).toHaveFocus();
  });

  it('brings the composer into view when a passage is selected', () => {
    const scrolled = vi.fn<(this: Element, options?: ScrollIntoViewOptions) => void>();
    Element.prototype.scrollIntoView = scrolled;
    try {
      const dialog = openReview();

      fireEvent.click(output(dialog).getByText('two'));

      const composer = within(dialog).getByRole('group', { name: 'Edit this passage' });
      expect(scrolled.mock.contexts.at(-1)?.contains(composer)).toBe(true);
      expect(scrolled).toHaveBeenLastCalledWith({ block: 'nearest' });
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it('closes the composer on Escape before it closes the view, and returns focus', async () => {
    render(<Harness initial={run()} />);
    const opener = screen.getByRole('button', { name: 'Review output' });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'Review output' });
    fireEvent.click(output(dialog).getByText('Revenue fell.'));

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(within(dialog).queryByRole('button', { name: 'Add comment' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Review output' })).toBeInTheDocument();
    expect(output(dialog).getByText('Revenue fell.')).toHaveFocus();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(opener).toHaveFocus();
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Review output' })).not.toBeInTheDocument(),
    );
  });

  it('keeps pending edits when the view is closed and says so on the step', () => {
    const dialog = openReview();
    addComment(dialog, 'Revenue fell.', 'It rose 12%.');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.getByText(/1 pending edit/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Review output' }));
    expect(screen.getByRole('list', { name: 'Pending' })).toHaveTextContent('It rose 12%.');
  });

  it('discards every pending edit in one action', () => {
    const dialog = openReview();
    addComment(dialog, 'Revenue fell.', 'It rose 12%.');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard pending edits' }));

    expect(within(dialog).queryByRole('list', { name: 'Pending' })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Apply edits' })).toBeDisabled();
  });

  it('marks an applied comment as rewritten and an unapplied one as only a comment', () => {
    const dialog = openReview(
      run({
        headId: 'rev-2',
        headText: ['# Memo', '', 'Revenue rose 12%.', '', '- one', '- two'].join('\n'),
        revisions: [
          revision({
            edits: [
              editSummary(),
              editSummary({
                id: 'e2',
                start: 23,
                end: 28,
                comment: 'Name the buyer.',
                status: 'unresolved',
                reason: 'No document names the buyer.',
                resultStart: null,
                resultEnd: null,
                before: '- one',
              }),
            ],
          }),
        ],
      }),
    );
    const [applied, unapplied] = within(
      within(dialog).getByRole('list', { name: 'Changed in this version' }),
    ).getAllByRole('listitem');

    expect(applied).toHaveTextContent('Rewritten from a comment');
    expect(applied.querySelector('[class*="--ai"]')).not.toBeNull();
    expect(unapplied).toHaveTextContent('Comment · Lance Park');
    expect(unapplied).not.toHaveTextContent('Rewritten from a comment');
    expect(unapplied).toHaveTextContent('Name the buyer.');
    expect(unapplied).toHaveTextContent('Not applied');
    expect(unapplied).toHaveTextContent('No document names the buyer.');
    expect(unapplied.querySelector('[class*="--ai"]')).toBeNull();
  });

  it('ticks Teach the skill on a comment and shows it as teaching in Pending', () => {
    const dialog = openReview();
    fireEvent.click(output(dialog).getByText('Revenue fell.'));
    fireEvent.change(within(dialog).getByLabelText('What should change in this passage'), {
      target: { value: 'Always cite the filing.' },
    });
    const box = within(dialog).getByRole('checkbox', { name: 'Teach the skill' });
    expect(box).not.toBeChecked();
    expect(box).toHaveAccessibleDescription(
      'For rules everyone on this project should get, not fixes to this document.',
    );
    fireEvent.click(box);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add comment' }));

    expect(within(dialog).getByRole('list', { name: 'Pending' })).toHaveTextContent('Teaches skill');
  });

  it('offers no Teach the skill box when editing the text by hand', () => {
    const dialog = openReview();
    fireEvent.click(output(dialog).getByText('Revenue fell.'));
    expect(within(dialog).getByRole('checkbox', { name: 'Teach the skill' })).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Edit text' }));

    expect(within(dialog).queryByRole('checkbox')).toBeNull();
  });

  it('keeps the tick when a pending comment is reopened', () => {
    const dialog = openReview();
    fireEvent.click(output(dialog).getByText('Revenue fell.'));
    fireEvent.change(within(dialog).getByLabelText('What should change in this passage'), {
      target: { value: 'Always cite the filing.' },
    });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Teach the skill' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add comment' }));

    fireEvent.click(output(dialog).getByText('Revenue fell.'));

    expect(within(dialog).getByRole('checkbox', { name: 'Teach the skill' })).toBeChecked();
  });

  it('says what teaching does beside Apply only while a pending comment is ticked', () => {
    const dialog = openReview(run(), vi.fn());
    fireEvent.click(output(dialog).getByText('Revenue fell.'));
    fireEvent.change(within(dialog).getByLabelText('What should change in this passage'), {
      target: { value: 'Always cite the filing.' },
    });
    expect(within(dialog).queryByText(/is marked to teach the skill/)).toBeNull();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Teach the skill' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add comment' }));

    expect(
      within(dialog).getByText(
        "1 comment is marked to teach the skill. After applying, use Teach the skill to update this step's skill for everyone on this project. Leave a comment unticked when it only fixes this document.",
      ),
    ).toBeInTheDocument();

    fireEvent.click(output(dialog).getByText('Revenue fell.'));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Teach the skill' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Update comment' }));

    expect(within(dialog).queryByText(/marked to teach the skill/)).toBeNull();
  });

  it('tells someone who may not teach that another banker can use Teach the skill', () => {
    const dialog = openReview();
    fireEvent.click(output(dialog).getByText('Revenue fell.'));
    fireEvent.change(within(dialog).getByLabelText('What should change in this passage'), {
      target: { value: 'Always cite the filing.' },
    });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Teach the skill' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add comment' }));

    expect(
      within(dialog).getByText(
        "1 comment is marked to teach the skill. After applying, someone who may improve this step's skill can use Teach the skill to update it for everyone on this project. Leave a comment unticked when it only fixes this document.",
      ),
    ).toBeInTheDocument();
  });

  it('sends teach with a ticked comment and not with an unticked one', async () => {
    const dialog = openReview();
    fireEvent.click(output(dialog).getByText('Revenue fell.'));
    fireEvent.change(within(dialog).getByLabelText('What should change in this passage'), {
      target: { value: 'Always cite the filing.' },
    });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Teach the skill' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add comment' }));
    addComment(dialog, 'one', 'Name the unit.');

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Apply 2 edits' }));
    });

    const edits = (server.posts[0]?.body as { edits: Record<string, unknown>[] }).edits;
    expect(edits[0]).toMatchObject({ kind: 'comment', comment: 'Always cite the filing.', teach: true });
    expect(edits[1]).toMatchObject({ kind: 'comment', comment: 'Name the unit.' });
    expect(edits[1]).not.toHaveProperty('teach');
  });

  it('tags an applied comment that teaches in Changed in this version', () => {
    const dialog = openReview(
      run({
        headId: 'rev-2',
        headText: ['# Memo', '', 'Revenue rose 12%.', '', '- one', '- two'].join('\n'),
        revisions: [
          revision({
            edits: [
              editSummary({ teach: true }),
              editSummary({ id: 'e2', start: 23, end: 28, comment: 'Name the unit.' }),
              editSummary({
                id: 'e3',
                start: 30,
                end: 35,
                comment: 'Name the buyer.',
                teach: true,
                status: 'unresolved',
                reason: 'No document names the buyer.',
                resultStart: null,
                resultEnd: null,
              }),
            ],
          }),
        ],
      }),
    );
    const [taught, plain, unresolved] = within(
      within(dialog).getByRole('list', { name: 'Changed in this version' }),
    ).getAllByRole('listitem');

    expect(taught).toHaveTextContent('Teaches skill');
    expect(plain).not.toHaveTextContent('Teaches skill');
    expect(unresolved).toHaveTextContent('Not applied');
    expect(unresolved).not.toHaveTextContent('Teaches skill');
  });

  it('drops the tick when a ticked comment is switched to Edit text and saved', async () => {
    const dialog = openReview();
    fireEvent.click(output(dialog).getByText('Revenue fell.'));
    fireEvent.change(within(dialog).getByLabelText('What should change in this passage'), {
      target: { value: 'Always cite the filing.' },
    });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Teach the skill' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add comment' }));

    fireEvent.click(output(dialog).getByText('Revenue fell.'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Edit text' }));
    fireEvent.change(within(dialog).getByLabelText('Passage text, in Markdown'), {
      target: { value: 'Revenue rose.' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save edit' }));

    expect(within(dialog).getByRole('list', { name: 'Pending' })).not.toHaveTextContent('Teaches skill');

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Apply 1 edit' }));
    });

    const edits = (server.posts[0]?.body as { edits: Record<string, unknown>[] }).edits;
    expect(edits[0]).toMatchObject({ kind: 'hand' });
    expect(edits[0]).not.toHaveProperty('teach');
  });

  it('selects a range the server accepts as aligned to whole blocks', () => {
    const doc = [
      '# Memo',
      '',
      'Revenue fell.',
      '',
      '- one',
      '  - nested',
      '- two',
      '',
      '| a | b |',
      '| - | - |',
      '| c | d |',
    ].join('\n');
    const dialog = openReview(run({ resultText: doc, headText: doc }));

    fireEvent.click(output(dialog).getByText('Revenue fell.'));
    fireEvent.click(output(dialog).getByText('c'), { shiftKey: true });
    fireEvent.change(within(dialog).getByLabelText('What should change in this passage'), {
      target: { value: 'Tighten all of this.' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add comment' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply 1 edit' }));

    const body = server.posts[0]?.body as { edits: { start: number; end: number }[] };
    const range = { start: body.edits[0].start, end: body.edits[0].end };
    const blocks = blockRanges(doc);
    expect(range.start).toBe(doc.indexOf('Revenue fell.'));
    expect(range.end).toBe(doc.indexOf('| c | d |') + '| c | d |'.length);
    expect(blocks.some((block) => block.start === range.start)).toBe(true);
    expect(blocks.some((block) => block.end === range.end)).toBe(true);
    expect(isAligned(blockRanges(doc), range)).toBe(true);
  });

  it('returns focus to the passage after saving a comment', () => {
    const dialog = openReview();

    addComment(dialog, 'Revenue fell.', 'It rose 12%.');

    expect(output(dialog).getByText('Revenue fell.')).toHaveFocus();
  });

  it('keeps focus inside the view when a version is restored', () => {
    server.reply = () => new Promise<Response>(() => undefined);
    const dialog = openReview(run({ headId: 'rev-2', headText: 'Second output.', revisions: [revision()] }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Earlier version' }));
    const restore = within(dialog).getByRole('button', { name: 'Restore this version' });
    restore.focus();

    fireEvent.click(restore);

    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(document.body);
  });

  it('marks only comment passages as applying in a mixed batch', () => {
    server.reply = () => new Promise<Response>(() => undefined);
    const dialog = openReview();
    addComment(dialog, 'Revenue fell.', 'It rose 12%.');
    fireEvent.click(output(dialog).getByText('one'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Edit text' }));
    fireEvent.change(within(dialog).getByLabelText('Passage text, in Markdown'), {
      target: { value: '- uno' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save edit' }));

    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply 2 edits' }));

    expect(output(dialog).getByText('Revenue fell.')).toHaveAttribute('data-mark', 'applying');
    expect(output(dialog).getByText('one')).toHaveAttribute('data-mark', 'pending');
  });
});

describe('saving an edit through the revisions hook', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('says the edit did not finish and keeps the edits when no revision lands before the deadline', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ revisionId: 'rev-2' }), { status: 202 })),
    );
    const reload = vi.fn(async () => [run()]);
    const { result } = renderHook(() =>
      useRunRevisions({ runsPath: RUNS_PATH, run: run(), reload, pollMs: 1, deadlineMs: 0 }),
    );
    act(() => {
      result.current.save({
        headId: RUN_ID,
        kind: 'comment',
        start: 8,
        end: 21,
        passage: 'Revenue fell.',
        value: 'It rose.',
        teach: false,
      });
    });

    await act(async () => {
      await result.current.apply();
    });

    expect(result.current.status).toEqual({
      kind: 'error',
      message: 'The edit did not finish. Nothing was changed. Your edits are kept.',
    });
    expect(result.current.pending.map((edit) => edit.value)).toEqual(['It rose.']);
  });

  it('refuses a draft picked on an earlier head and says the output changed', () => {
    const reload = vi.fn(async () => [run()]);
    const { result } = renderHook(() =>
      useRunRevisions({ runsPath: RUNS_PATH, run: run({ headId: 'rev-2' }), reload }),
    );

    act(() => {
      result.current.save({
        headId: RUN_ID,
        kind: 'comment',
        start: 8,
        end: 21,
        passage: 'Revenue fell.',
        value: 'It rose.',
        teach: false,
      });
    });

    expect(result.current.pending).toEqual([]);
    expect(result.current.status).toEqual({ kind: 'error', message: OUTPUT_CHANGED });
  });

  it('saves a draft picked on the head it holds now', () => {
    const reload = vi.fn(async () => [run()]);
    const { result } = renderHook(() => useRunRevisions({ runsPath: RUNS_PATH, run: run(), reload }));

    act(() => {
      result.current.save({
        headId: RUN_ID,
        kind: 'comment',
        start: 8,
        end: 21,
        passage: 'Revenue fell.',
        value: 'It rose.',
        teach: false,
      });
    });

    expect(result.current.pending.map((edit) => edit.value)).toEqual(['It rose.']);
    expect(result.current.status).toEqual({ kind: 'idle' });
  });
});
