import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RunOutput } from '@/components/rail/review/RunOutput';
import { wholeOutputRange } from '@/components/rail/review/wholeOutput';
import { validateEdits } from '@/lib/skillRun/revisions';
import type { RevisionSummary, SkillRunSummary } from '@/lib/skillRun/types';

const RUNS_PATH = '/api/v1/deals/ATLAS-2026-001/steps/custom%3Astep/skill-runs';
const RUN_ID = '3f0d6f9a-1f4c-4a2f-9f37-2f8f2c0f6f11';
const TEXT = ['# Memo', '', 'Revenue fell.', '', '- one', '- two', ''].join('\n');
const ASK = 'Lead with the buyer fit and cut the list.';

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

function revision(range: { start: number; end: number }): RevisionSummary {
  return {
    id: 'rev-2',
    parentId: RUN_ID,
    kind: 'edits',
    outcome: 'succeeded',
    errorMessage: null,
    actorName: 'Storm Duncan',
    createdAt: '2026-10-13T10:00:00.000Z',
    version: 2,
    edits: [
      {
        id: 'e1',
        kind: 'comment',
        ...range,
        comment: ASK,
        status: 'applied',
        reason: null,
        teach: false,
        sent: false,
        resultStart: 0,
        resultEnd: 20,
        before: TEXT.trimEnd(),
      },
    ],
    restoredFrom: null,
    skillMounted: true,
  };
}

const server = {
  posts: [] as { url: string; body: unknown }[],
  reply: (): Response | Promise<Response> => new Response('{}', { status: 500 }),
  lists: [] as SkillRunSummary[][],
};

function Harness({ initial }: { initial: SkillRunSummary }) {
  const [runs, setRuns] = React.useState([initial]);
  const reload = React.useCallback(async () => {
    const next = server.lists.length > 1 ? (server.lists.shift() ?? [initial]) : (server.lists[0] ?? [initial]);
    setRuns(next);
    return next;
  }, [initial]);
  return <RunOutput runsPath={RUNS_PATH} run={runs[0]} documents={[]} reload={reload} pollMs={1} />;
}

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
      return new Response('{}', { status: 200 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the whole-output comment the revise box sends', () => {
  it('covers every passage and is what validateEdits accepts, where a literal 0..length is not', () => {
    const range = wholeOutputRange(TEXT);
    expect(range).toEqual({ start: 0, end: TEXT.trimEnd().length });
    expect(validateEdits(TEXT, [range!])).toBeNull();
    // The output ends with a newline, so 0..length does not end on a passage.
    expect(validateEdits(TEXT, [{ start: 0, end: TEXT.length }])).toBe(
      'An edit does not cover whole passages',
    );
  });

  it('starts at the first passage when the output opens with blank lines', () => {
    const text = '\n\nOne line.\n\nTwo.';
    const range = wholeOutputRange(text);
    expect(range).toEqual({ start: 2, end: text.length });
    expect(validateEdits(text, [range!])).toBeNull();
  });

  it('has nothing to cover on an empty output', () => {
    expect(wholeOutputRange('   \n')).toBeNull();
  });
});

describe('What should change?', () => {
  it('asks in a typed box with example lines as hint text, and no preset submits a revision', () => {
    render(<Harness initial={run()} />);

    const box = screen.getByRole('textbox', { name: 'What should change?' });
    expect(box).toHaveAccessibleDescription(/For example: "Cut the opening to two sentences\."/);
    const create = screen.getByRole('button', { name: 'Create version 2' });
    expect(create).toBeDisabled();
    // The only buttons: open the review and create the next version.
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Review output',
      'Create version 2',
    ]);
    fireEvent.click(create);
    expect(server.posts).toHaveLength(0);
  });

  it('records the next version through the revisions endpoint as one whole-output comment', async () => {
    const range = wholeOutputRange(TEXT)!;
    server.reply = () => new Response(JSON.stringify({ revisionId: 'rev-2' }), { status: 202 });
    server.lists = [
      [run()],
      [run({ headId: 'rev-2', headText: 'Buyer fit first.', revisions: [revision(range)] })],
    ];
    render(<Harness initial={run()} />);

    fireEvent.change(screen.getByRole('textbox', { name: 'What should change?' }), {
      target: { value: `  ${ASK}  ` },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create version 2' }));

    expect(await screen.findByText('1 edit applied. Version 2 is recorded.')).toBeInTheDocument();
    expect(server.posts).toEqual([
      {
        url: `${RUNS_PATH}/${RUN_ID}/revisions`,
        body: {
          parentId: RUN_ID,
          edits: [{ kind: 'comment', start: range.start, end: range.end, comment: ASK }],
        },
      },
    ]);
    // Never teaches the skill: that is the question for Storm "Should
    // revisions also improve the skill?".
    expect(JSON.stringify(server.posts[0].body)).not.toContain('teach');
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'What should change?' })).toHaveValue(''),
    );
    expect(screen.getByRole('button', { name: 'Create version 3' })).toBeDisabled();
  });

  it('keeps Create version off for whitespace alone, and sends nothing', async () => {
    render(<Harness initial={run()} />);

    fireEvent.change(screen.getByRole('textbox', { name: 'What should change?' }), {
      target: { value: '   ' },
    });
    const create = screen.getByRole('button', { name: 'Create version 2' });
    expect(create).toBeDisabled();
    fireEvent.click(create);
    fireEvent.submit(create.closest('form') ?? create);
    await act(async () => {});
    expect(server.posts).toHaveLength(0);
  });

  it('keeps what was typed when the revision is refused', async () => {
    server.reply = () =>
      new Response(JSON.stringify({ error: 'An edit does not cover whole passages' }), { status: 422 });
    render(<Harness initial={run()} />);

    fireEvent.change(screen.getByRole('textbox', { name: 'What should change?' }), {
      target: { value: ASK },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create version 2' }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'What should change?' })).toHaveValue(ASK);
  });

  it('offers no box on a run whose output is blank, and says why', () => {
    render(<Harness initial={run({ resultText: '  \n', headText: '  \n' })} />);

    expect(screen.queryByRole('textbox', { name: 'What should change?' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Create version/ })).not.toBeInTheDocument();
    expect(screen.getByText('This draft has no text to change.')).toBeInTheDocument();
  });
});
