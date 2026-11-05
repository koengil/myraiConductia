import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DRAFT_BUTTON } from './helpers/draftButton';

import {
  INSTRUCTIONS_LABEL,
  NOT_RECORDED_MESSAGE,
  SKILL_UNREADABLE_MESSAGE,
  SkillStepRunner,
} from '@/components/rail/SkillStepRunner';
import {
  CATALOG_VERSION_PRUNED_MESSAGE,
  CATALOG_VERSION_UNRECOVERABLE_MESSAGE,
} from '@/lib/ignatious/failure';
import { FlagsProvider } from '@/lib/flags/FlagsContext';
import { FLAG_REGISTRY, type FlagKey } from '@/lib/flags/keys';
import type { FlagMap } from '@/lib/flags/resolveFlags';
import type { ProjectRailStep } from '@/lib/rail/projectRail';

const BINDING = {
  skillId: '2d362e20-0709-4ba0-bbd7-d21831148282',
  versionId: '0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6',
  digest: 'a'.repeat(64),
};

const RUN_ID = '3f0d6f9a-1f4c-4a2f-9f37-2f8f2c0f6f11';

const STEP: ProjectRailStep = {
  id: '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b',
  stepId: 'custom:0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6',
  origin: 'custom',
  phaseIndex: 1,
  displayOrder: 3,
  seq: null,
  status: 'pending',
  anchorStepId: null,
  removedAt: null,
  removedBy: null,
  skip: null,
  definition: {
    schemaVersion: 1,
    type: 'skill',
    title: 'Weekly project update',
    description: 'Prepare a concise update.',
    inputs: [
      {
        key: 'primary',
        kind: 'text',
        label: 'Input',
        helperText: 'What to emphasise.',
        required: true,
      },
    ],
    skillBinding: BINDING,
  },
};

const MANUAL_STEP: ProjectRailStep = {
  ...STEP,
  definition: { title: 'Sign the engagement letter', description: 'By hand.' },
};

const CATALOG_STEP: ProjectRailStep = {
  id: 'deal-step-uuid-9',
  stepId: 'p1-s10',
  origin: 'catalog',
  phaseIndex: 1,
  displayOrder: 4,
  seq: 10,
  status: 'pending',
  anchorStepId: null,
  removedAt: null,
  removedBy: null,
  skip: null,
  definition: null,
};

function sseBody(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          `event: run\ndata: ${JSON.stringify({ type: 'run', runId: 'provider-run-1' })}\n\n`,
        ),
      );
      controller.enqueue(
        encoder.encode(`event: text\ndata: ${JSON.stringify({ type: 'text', text })}\n\n`),
      );
      controller.enqueue(
        encoder.encode(
          `event: done\ndata: ${JSON.stringify({ type: 'done', costUsd: 0.2 })}\n\n`,
        ),
      );
      controller.close();
    },
  });
}

function heldBody(signal?: AbortSignal | null): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
    },
  });
}

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-2',
    outcome: 'succeeded',
    actorName: 'Storm Duncan',
    input: 'newer',
    inputs: {},
    resultText: 'newer result',
    errorMessage: null,
    costUsd: null,
    startedAt: null,
    createdAt: '2026-09-14T11:00:00.000Z',
    binding: BINDING,
    documents: [],
    ...overrides,
  };
}

const AS_OF_FIELD = {
  name: 'asOf',
  type: 'date',
  label: 'As of',
  description: null,
  values: [],
  required: true,
  default: null,
};

function flagsWith(...enabled: FlagKey[]): FlagMap {
  return Object.fromEntries(
    Object.keys(FLAG_REGISTRY).map((key) => [key, enabled.includes(key as FlagKey)]),
  ) as FlagMap;
}

function revisedRow(overrides: Record<string, unknown> = {}) {
  return runRow({
    headId: 'rev-2',
    headText: 'the revised result',
    revisions: [
      {
        id: 'rev-2',
        parentId: 'run-2',
        kind: 'edits',
        outcome: 'succeeded',
        errorMessage: null,
        actorName: 'Lance Park',
        createdAt: '2026-09-14T12:00:00.000Z',
        version: 2,
        edits: [],
        restoredFrom: null,
        skillMounted: true,
      },
    ],
    ...overrides,
  });
}

type Call = { url: string; init?: RequestInit };

const calls: Call[] = [];
const state = {
  work: { primary: 'Summarise the week' } as Record<string, unknown>,
  runs: [] as Record<string, unknown>[],
  streamStatus: 200,
  streamBody: { error: 'nope' } as unknown,
  streamText: 'Here is the update.',
  recordStatus: 201,
  holdStream: false,
  versionsCurrent: null as Record<string, unknown> | null,
  versionsStatus: 200,
  currentInputs: [] as Record<string, unknown>[],
  extraCatalogOptions: [] as Record<string, unknown>[],
};

function isStream(url: string): boolean {
  return url.endsWith('/skill-runs/stream');
}

function isRuns(url: string): boolean {
  return url.endsWith('/skill-runs');
}

function isVersions(url: string): boolean {
  return url.endsWith('/skill-versions');
}

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (isStream(url)) {
        if (state.holdStream) return new Response(heldBody(init?.signal), { status: 200 });
        return state.streamStatus === 200
          ? new Response(sseBody(state.streamText), { status: 200 })
          : new Response(JSON.stringify(state.streamBody), { status: state.streamStatus });
      }
      if (isRuns(url) && init?.method === 'POST' && state.recordStatus !== 201) {
        calls.push({ url, init });
        return new Response(JSON.stringify({ error: 'nope' }), { status: state.recordStatus });
      }
      if (isRuns(url) && init?.method === 'POST') {
        const sent = JSON.parse(init.body as string) as Record<string, unknown>;
        const stored = runRow({
          id: sent.runId,
          outcome: sent.outcome,
          input: sent.instructions ?? null,
          inputs: sent.inputs ?? {},
          resultText: sent.resultText ?? null,
          errorMessage: sent.errorMessage ?? null,
          createdAt: '2026-09-14T12:00:00.000Z',
        });
        state.runs = [stored, ...state.runs];
        return new Response(JSON.stringify({ run: stored }), { status: 201 });
      }
      if (isRuns(url)) {
        return new Response(JSON.stringify({ runs: state.runs }), { status: 200 });
      }
      if (isVersions(url)) {
        if (state.versionsStatus !== 200) {
          return new Response(JSON.stringify({ error: 'Forbidden' }), {
            status: state.versionsStatus,
          });
        }
        const catalog = [
          ...(state.versionsCurrent
            ? [
                {
                  reference: state.versionsCurrent,
                  label: 'v1',
                  authorName: null,
                  createdAt: null,
                  available: true,
                  unavailableReason: null,
                  inputs: state.currentInputs,
                },
              ]
            : []),
          ...state.extraCatalogOptions,
        ];
        return new Response(
          JSON.stringify({
            current: state.versionsCurrent,
            project: [],
            projectUnavailableReason: null,
            catalog,
            ancestorContract: null,
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ step: { work: state.work } }), { status: 200 });
    }),
  );
}

function recordCall(): Call | undefined {
  return calls.find((call) => isRuns(call.url) && call.init?.method === 'POST');
}

beforeEach(() => {
  calls.length = 0;
  state.work = { primary: 'Summarise the week' };
  state.runs = [];
  state.streamStatus = 200;
  state.streamBody = { error: 'nope' };
  state.streamText = 'Here is the update.';
  state.recordStatus = 201;
  state.holdStream = false;
  state.versionsCurrent = null;
  state.versionsStatus = 200;
  state.currentInputs = [];
  state.extraCatalogOptions = [];
  vi.stubGlobal('crypto', { ...globalThis.crypto, randomUUID: () => RUN_ID });
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SkillStepRunner', () => {
  it('names what the draft button makes and says in one plain line who does what', async () => {
    render(<SkillStepRunner projectId="deal-1" step={STEP} />);

    expect(
      await screen.findByRole('button', { name: 'Draft with the Weekly project update skill' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Conductia drafts with the Weekly project update skill. You review the draft before you mark the step complete.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Draft this step' })).not.toBeInTheDocument();
  });

  it('runs the step, keeps the input, and records the run', async () => {
    render(<SkillStepRunner projectId="deal-1" step={STEP} />);

    const input = await screen.findByLabelText('Additional instructions');
    await waitFor(() => expect(input).toHaveValue('Summarise the week'));

    fireEvent.click(screen.getByRole('button', { name: DRAFT_BUTTON }));

    await waitFor(() => expect(screen.getByText('Here is the update.')).toBeInTheDocument());
    expect(screen.getByLabelText('Additional instructions')).toHaveValue('Summarise the week');

    const sent = JSON.parse(recordCall()?.init?.body as string) as Record<string, unknown>;
    expect(sent).toMatchObject({
      runId: RUN_ID,
      outcome: 'succeeded',
      resultText: 'Here is the update.',
      providerRunId: 'provider-run-1',
    });
    expect(sent).not.toHaveProperty('input');
    expect(sent).not.toHaveProperty('costUsd');
  });

  it('shows a failure, records it, and keeps the input', async () => {
    state.streamStatus = 503;

    render(<SkillStepRunner projectId="deal-1" step={STEP} />);
    await waitFor(() =>
      expect(screen.getByLabelText('Additional instructions')).toHaveValue('Summarise the week'),
    );

    fireEvent.click(screen.getByRole('button', { name: DRAFT_BUTTON }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByLabelText('Additional instructions')).toHaveValue('Summarise the week');
    expect(JSON.parse(recordCall()?.init?.body as string)).toMatchObject({
      runId: RUN_ID,
      outcome: 'failed',
    });
    expect(JSON.parse(recordCall()?.init?.body as string).resultText ?? null).toBeNull();
  });

  it('lists history and shows a selected earlier run without touching the input', async () => {
    state.runs = [
      runRow(),
      runRow({
        id: 'run-1',
        actorName: 'Ana Reyes',
        input: 'older',
        resultText: 'older result',
        createdAt: '2026-09-14T10:00:00.000Z',
      }),
    ];

    render(<SkillStepRunner projectId="deal-1" step={STEP} />);

    expect(await screen.findByText('newer result')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Ana Reyes/ }));

    expect(screen.getByText('older result')).toBeInTheDocument();
    expect(screen.queryByText('newer result')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Additional instructions')).toHaveValue('Summarise the week');
  });

  it('names the documents a selected run filed', async () => {
    state.runs = [
      runRow({
        documents: [
          { id: 'doc-1', name: 'weekly-update.docx', folder: 'admin', createdAt: '2026-09-14T11:01:00.000Z' },
        ],
      }),
    ];

    render(<SkillStepRunner projectId="deal-1" step={STEP} />);

    expect(await screen.findByText('weekly-update.docx')).toBeInTheDocument();
  });

  it('shows history and no run control on a removed step', async () => {
    state.runs = [revisedRow()];

    render(
      <SkillStepRunner
        projectId="deal-1"
        step={{ ...STEP, removedAt: '2026-09-14T09:00:00Z' }}
      />,
    );

    expect(await screen.findByText(/This step was removed/)).toBeInTheDocument();
    expect(screen.getByText('the revised result')).toBeInTheDocument();
    expect(screen.queryByText('newer result')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: DRAFT_BUTTON })).toBeNull();
    expect(screen.getByRole('button', { name: /Storm Duncan/ })).toBeInTheDocument();
    expect(calls.some((call) => isStream(call.url))).toBe(false);
  });

  it('keeps the output read-only while skill_output_revisions is off', async () => {
    state.runs = [revisedRow()];

    render(<SkillStepRunner projectId="ATLAS-2026-001" step={STEP} />);

    expect(await screen.findByText('the revised result')).toBeInTheDocument();
    expect(screen.queryByText('newer result')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Review output' })).not.toBeInTheDocument();
  });

  it('offers Review output on a recorded, succeeded run when the flag is on', async () => {
    state.runs = [runRow()];

    render(
      <FlagsProvider value={flagsWith('skill_output_revisions')}>
        <SkillStepRunner projectId="ATLAS-2026-001" step={STEP} />
      </FlagsProvider>,
    );

    expect(await screen.findByRole('button', { name: 'Review output' })).toBeInTheDocument();
    expect(screen.getByText(/Version 1 of 1 · Storm Duncan/)).toBeInTheDocument();
  });

  it('shows the latest version of a revised output, not the first', async () => {
    state.runs = [
      revisedRow(),
    ];

    render(
      <FlagsProvider value={flagsWith('skill_output_revisions')}>
        <SkillStepRunner projectId="ATLAS-2026-001" step={STEP} />
      </FlagsProvider>,
    );

    expect(await screen.findByText('the revised result')).toBeInTheDocument();
    expect(screen.queryByText('newer result')).not.toBeInTheDocument();
    expect(screen.getByText(/Version 2 of 2 · Lance Park/)).toBeInTheDocument();
  });

  it('does not offer it on a failed run or a removed step', async () => {
    state.runs = [runRow({ outcome: 'failed', resultText: null, errorMessage: 'It failed.' })];
    const first = render(
      <FlagsProvider value={flagsWith('skill_output_revisions')}>
        <SkillStepRunner projectId="ATLAS-2026-001" step={STEP} />
      </FlagsProvider>,
    );
    await screen.findByRole('list', { name: 'Run history' });
    expect(screen.queryByRole('button', { name: 'Review output' })).not.toBeInTheDocument();
    first.unmount();

    state.runs = [runRow()];
    render(
      <FlagsProvider value={flagsWith('skill_output_revisions')}>
        <SkillStepRunner
          projectId="ATLAS-2026-001"
          step={{ ...STEP, removedAt: '2026-09-14T09:00:00.000Z' }}
        />
      </FlagsProvider>,
    );
    expect(await screen.findByText('newer result')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Review output' })).not.toBeInTheDocument();
  });

  it.each([
    ['answers 500', () => new Response('{}', { status: 500 })],
    ['rejects', () => Promise.reject(new Error('offline'))],
  ])('keeps the review open when a reload of the run list %s', async (_name, failure) => {
    state.runs = [
      revisedRow(),
    ];
    const healthy = fetch;
    let listReads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/revisions')) {
          return new Response(JSON.stringify({ revisionId: 'rev-3' }), { status: 202 });
        }
        if (isRuns(url) && init?.method === undefined) {
          listReads += 1;
          if (listReads > 1) return failure();
        }
        return healthy(url, init);
      }),
    );

    render(
      <FlagsProvider value={flagsWith('skill_output_revisions')}>
        <SkillStepRunner projectId="ATLAS-2026-001" step={STEP} />
      </FlagsProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Review output' }));
    const dialog = await screen.findByRole('dialog', { name: 'Review output' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Earlier version' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore this version' }));

    await waitFor(() => expect(listReads).toBeGreaterThan(1));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(screen.getByRole('dialog', { name: 'Review output' })).toBeInTheDocument();
    expect(screen.getAllByText(/Version 2 of 2/).length).toBeGreaterThan(0);
  });

  function listReads(): number {
    return calls.filter((call) => isRuns(call.url) && call.init?.method === undefined).length;
  }

  const olderRow = () =>
    runRow({ id: 'run-1', resultText: 'older result', createdAt: '2026-09-14T10:00:00.000Z' });

  it('shows the new head when a run is selected again after its revision landed', async () => {
    state.runs = [runRow(), olderRow()];
    render(
      <FlagsProvider value={flagsWith('skill_output_revisions')}>
        <SkillStepRunner projectId="ATLAS-2026-001" step={STEP} />
      </FlagsProvider>,
    );
    await screen.findByText(/Version 1 of 1 · Storm Duncan/);

    fireEvent.click(within(screen.getByRole('list', { name: 'Run history' })).getAllByRole('button', { name: /succeeded/ })[1]);
    expect(await screen.findByText('older result')).toBeInTheDocument();

    state.runs = [revisedRow(), olderRow()];
    fireEvent.click(within(screen.getByRole('list', { name: 'Run history' })).getAllByRole('button', { name: /succeeded/ })[0]);

    expect(await screen.findByText('the revised result')).toBeInTheDocument();
    expect(screen.getByText(/Version 2 of 2 · Lance Park/)).toBeInTheDocument();
  });

  it('reloads the run list after a refused draft', async () => {
    state.runs = [runRow()];
    state.versionsCurrent = { kind: 'mount', name: 'weekly-update', version: 1, digest: 'a'.repeat(64) };
    state.currentInputs = [AS_OF_FIELD];
    state.streamStatus = 422;
    state.streamBody = {
      error: {
        code: 'validation',
        detail: { problems: [{ name: 'asOf', message: 'expected a date' }] },
      },
    };
    render(
      <FlagsProvider value={flagsWith('skill_output_revisions')}>
        <SkillStepRunner projectId="deal-1" step={STEP} />
      </FlagsProvider>,
    );
    await screen.findByLabelText(/As of/);
    fireEvent.change(screen.getByLabelText(/As of/), { target: { value: '2026-09-30' } });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: DRAFT_BUTTON })).not.toBeDisabled(),
    );
    const before = listReads();
    state.runs = [revisedRow()];

    fireEvent.click(screen.getByRole('button', { name: DRAFT_BUTTON }));

    expect(await screen.findByText('expected a date')).toBeInTheDocument();
    expect(await screen.findByText('the revised result')).toBeInTheDocument();
    expect(listReads()).toBe(before + 1);
  });

  it('makes no extra run-list request when a run is selected with the flag off', async () => {
    state.runs = [runRow(), olderRow()];
    render(<SkillStepRunner projectId="ATLAS-2026-001" step={STEP} />);
    await screen.findByText('newer result');
    const before = listReads();

    fireEvent.click(within(screen.getByRole('list', { name: 'Run history' })).getAllByRole('button', { name: /succeeded/ })[1]);

    expect(await screen.findByText('older result')).toBeInTheDocument();
    expect(listReads()).toBe(before);
  });

  function draftSetup() {
    state.versionsCurrent = { kind: 'mount', name: 'weekly-update', version: 1, digest: 'a'.repeat(64) };
    state.currentInputs = [AS_OF_FIELD];
  }

  async function startDraft() {
    await screen.findByLabelText(/As of/);
    fireEvent.change(screen.getByLabelText(/As of/), { target: { value: '2026-09-30' } });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: DRAFT_BUTTON })).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: DRAFT_BUTTON }));
  }

  it('anchors a pending edit to the new head when the selected row is clicked after the head moved', async () => {
    const before = 'Alpha.\n\nBravo.';
    const after = 'Zulu Zulu.\n\nAlpha.\n\nBravo.';
    state.runs = [runRow({ resultText: before })];
    const revisionBodies: Record<string, unknown>[] = [];
    const healthy = fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/revisions')) {
          revisionBodies.push(JSON.parse(init?.body as string) as Record<string, unknown>);
          return new Response(JSON.stringify({ error: 'stop' }), { status: 500 });
        }
        return healthy(url, init);
      }),
    );
    render(
      <FlagsProvider value={flagsWith('skill_output_revisions')}>
        <SkillStepRunner projectId="ATLAS-2026-001" step={STEP} />
      </FlagsProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Review output' }));
    const dialog = await screen.findByRole('dialog', { name: 'Review output' });
    fireEvent.click(within(within(dialog).getByRole('group', { name: 'Output' })).getByText('Bravo.'));
    fireEvent.change(within(dialog).getByLabelText('What should change in this passage'), {
      target: { value: 'Name the buyer.' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add comment' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));

    state.runs = [
      revisedRow({
        resultText: before,
        headText: after,
      }),
    ];
    fireEvent.click(
      within(screen.getByRole('list', { name: 'Run history' })).getAllByRole('button', { name: /succeeded/ })[0],
    );
    await screen.findByText(/Version 2 of 2/);
    fireEvent.click(screen.getByRole('button', { name: 'Review output' }));
    const reopened = await screen.findByRole('dialog', { name: 'Review output' });
    fireEvent.click(within(reopened).getByRole('button', { name: 'Apply 1 edit' }));

    await waitFor(() => expect(revisionBodies).toHaveLength(1));
    const body = revisionBodies[0] as { parentId: string; edits: { start: number; end: number }[] };
    expect(body.parentId).toBe('rev-2');
    expect(after.slice(body.edits[0].start, body.edits[0].end)).toBe('Bravo.');
  });

  it('reloads the run list when a draft is cancelled, and shows the head it returns', async () => {
    state.runs = [runRow()];
    draftSetup();
    state.holdStream = true;
    render(
      <FlagsProvider value={flagsWith('skill_output_revisions')}>
        <SkillStepRunner projectId="deal-1" step={STEP} />
      </FlagsProvider>,
    );
    await startDraft();
    const cancel = await screen.findByRole('button', { name: 'Cancel' });
    state.runs = [revisedRow()];

    fireEvent.click(cancel);

    expect(await screen.findByText('the revised result')).toBeInTheDocument();
    expect(screen.getByText(/Version 2 of 2 · Lance Park/)).toBeInTheDocument();
  });

  it('makes no extra run-list request on a refused or cancelled draft with the flag off', async () => {
    state.runs = [runRow()];
    draftSetup();
    state.streamStatus = 422;
    state.streamBody = {
      error: { code: 'validation', detail: { problems: [{ name: 'asOf', message: 'expected a date' }] } },
    };
    const refused = render(<SkillStepRunner projectId="deal-1" step={STEP} />);
    await startDraft();
    expect(await screen.findByText('expected a date')).toBeInTheDocument();
    expect(listReads()).toBe(1);
    refused.unmount();

    calls.length = 0;
    state.streamStatus = 200;
    state.holdStream = true;
    render(<SkillStepRunner projectId="deal-1" step={STEP} />);
    await startDraft();
    const cancel = await screen.findByRole('button', { name: 'Cancel' });
    const before = listReads();
    fireEvent.click(cancel);
    expect(await screen.findByText('Cancelled. Nothing was recorded.')).toBeInTheDocument();
    expect(listReads()).toBe(before);
  });

  it('says so plainly when a step has no skill attached', async () => {
    render(<SkillStepRunner projectId="deal-1" step={MANUAL_STEP} />);

    expect(await screen.findByText('No skill attached yet.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: DRAFT_BUTTON })).toBeNull();
  });

  it('records nothing when the step unmounts mid-run', async () => {
    state.holdStream = true;

    const view = render(<SkillStepRunner projectId="deal-1" step={STEP} />);
    await waitFor(() =>
      expect(screen.getByLabelText('Additional instructions')).toHaveValue('Summarise the week'),
    );

    fireEvent.click(screen.getByRole('button', { name: DRAFT_BUTTON }));
    await waitFor(() => expect(calls.some((call) => isStream(call.url))).toBe(true));
    view.unmount();

    await waitFor(() => expect(recordCall()).toBeUndefined());
    expect(recordCall()).toBeUndefined();
  });

  it('keeps the result on screen when the run cannot be recorded', async () => {
    state.recordStatus = 500;

    render(<SkillStepRunner projectId="deal-1" step={STEP} />);
    await waitFor(() =>
      expect(screen.getByLabelText('Additional instructions')).toHaveValue('Summarise the week'),
    );

    fireEvent.click(screen.getByRole('button', { name: DRAFT_BUTTON }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(NOT_RECORDED_MESSAGE),
    );
    expect(screen.getByText('Here is the update.')).toBeInTheDocument();
  });

  it('runs with empty instructions when the running version declares no fields', async () => {
    state.work = {};

    render(<SkillStepRunner projectId="deal-1" step={STEP} />);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: DRAFT_BUTTON })).not.toBeDisabled(),
    );

    fireEvent.click(screen.getByRole('button', { name: DRAFT_BUTTON }));

    await waitFor(() => expect(screen.getByText('Here is the update.')).toBeInTheDocument());

    const streamCall = calls.find((call) => isStream(call.url));
    const sentBody = JSON.parse(streamCall?.init?.body as string) as Record<string, unknown>;
    expect(sentBody.inputs).toEqual({});
    expect(sentBody.instructions).toBeNull();
  });

  it('resolves a catalog step through skill-versions and renders the runner', async () => {
    state.versionsCurrent = { kind: 'mount', name: 'meeting-intelligence', version: 1, digest: 'a'.repeat(64) };

    render(<SkillStepRunner projectId="deal-1" step={CATALOG_STEP} />);

    expect(await screen.findByLabelText('Additional instructions')).toBeInTheDocument();
    expect(screen.queryByText('No skill attached yet.')).toBeNull();
    expect(screen.getByRole('button', { name: DRAFT_BUTTON })).toBeInTheDocument();
  });

  it('says no skill attached for a catalog step once resolution comes back empty', async () => {
    state.versionsCurrent = null;

    render(<SkillStepRunner projectId="deal-1" step={CATALOG_STEP} />);

    expect(await screen.findByText('No skill attached yet.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: DRAFT_BUTTON })).toBeNull();
  });

  it('separates an unreadable version list from a step with no skill, and keeps the history', async () => {
    state.versionsStatus = 403;
    state.runs = [runRow({ id: 'run-7', actorName: 'Priya Shah' })];

    render(<SkillStepRunner projectId="deal-1" step={CATALOG_STEP} />);

    expect(await screen.findByText(SKILL_UNREADABLE_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByText('No skill attached yet.')).toBeNull();
    expect(screen.getByRole('list', { name: 'Run history' })).toBeInTheDocument();
    expect(screen.getByText(/Priya Shah/)).toBeInTheDocument();
  });

  it('reads the bench version code rather than reporting the bare status', async () => {
    state.streamStatus = 409;
    state.streamBody = {
      error: { code: 'version_pruned', message: 'that catalog version no longer keeps its bytes' },
    };

    render(<SkillStepRunner projectId="deal-1" step={STEP} />);
    await waitFor(() => expect(screen.getByLabelText('Additional instructions')).toHaveValue('Summarise the week'));
    fireEvent.click(screen.getByRole('button', { name: DRAFT_BUTTON }));

    expect(await screen.findByRole('alert')).toHaveTextContent(CATALOG_VERSION_PRUNED_MESSAGE);
  });

  it('reads the unrecoverable version code too', async () => {
    state.streamStatus = 409;
    state.streamBody = { error: { code: 'version_not_recoverable', message: 'gone' } };

    render(<SkillStepRunner projectId="deal-1" step={STEP} />);
    await waitFor(() => expect(screen.getByLabelText('Additional instructions')).toHaveValue('Summarise the week'));
    fireEvent.click(screen.getByRole('button', { name: DRAFT_BUTTON }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      CATALOG_VERSION_UNRECOVERABLE_MESSAGE,
    );
  });
});

function stepPatchCall(): Call | undefined {
  return calls.find(
    (call) =>
      !isStream(call.url) && !isRuns(call.url) && !isVersions(call.url) && call.init?.method === 'PATCH',
  );
}

describe('SkillStepRunner declared input fields', () => {
  beforeEach(() => {
    state.versionsCurrent = { kind: 'mount', name: 'weekly-update', version: 1, digest: 'a'.repeat(64) };
    state.currentInputs = [AS_OF_FIELD];
  });

  it('disables Draft until the required field has a value, naming it inline', async () => {
    render(<SkillStepRunner projectId="deal-1" step={STEP} />);

    expect(await screen.findByLabelText(/As of/)).toBeInTheDocument();
    expect(screen.getByLabelText('Additional instructions')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: DRAFT_BUTTON })).toBeDisabled();
    expect(screen.getByText('As of is required.')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/As of/), { target: { value: '2026-09-30' } });

    await waitFor(() =>
      expect(screen.getByRole('button', { name: DRAFT_BUTTON })).not.toBeDisabled(),
    );
    expect(screen.queryByText('As of is required.')).not.toBeInTheDocument();
  });

  it('sends the typed field as inputs, and empty instructions as null, on stream and record', async () => {
    state.work = {};

    render(<SkillStepRunner projectId="deal-1" step={STEP} />);

    await screen.findByLabelText(/As of/);
    fireEvent.change(screen.getByLabelText(/As of/), { target: { value: '2026-09-30' } });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: DRAFT_BUTTON })).not.toBeDisabled(),
    );

    fireEvent.click(screen.getByRole('button', { name: DRAFT_BUTTON }));

    await waitFor(() => expect(screen.getByText('Here is the update.')).toBeInTheDocument());

    const streamCall = calls.find((call) => isStream(call.url));
    const streamBody = JSON.parse(streamCall?.init?.body as string) as Record<string, unknown>;
    expect(streamBody.inputs).toEqual({ asOf: '2026-09-30' });
    expect(streamBody.instructions).toBeNull();

    const recorded = JSON.parse(recordCall()?.init?.body as string) as Record<string, unknown>;
    expect(recorded.inputs).toEqual({ asOf: '2026-09-30' });
  });

  it('shows an old step whose only input is work.primary in Additional instructions, and runs with no fields', async () => {
    state.currentInputs = [];
    state.work = { primary: 'Old text' };

    render(<SkillStepRunner projectId="deal-1" step={STEP} />);

    await waitFor(() =>
      expect(screen.getByLabelText('Additional instructions')).toHaveValue('Old text'),
    );
    expect(screen.queryByLabelText(/As of/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: DRAFT_BUTTON })).not.toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: DRAFT_BUTTON }));

    await waitFor(() => expect(screen.getByText('Here is the update.')).toBeInTheDocument());

    const streamCall = calls.find((call) => isStream(call.url));
    const streamBody = JSON.parse(streamCall?.init?.body as string) as Record<string, unknown>;
    expect(streamBody.inputs).toEqual({});
    expect(streamBody.instructions).toBe('Old text');
  });

  it('autosaves the whole inputs object into work on blur', async () => {
    render(<SkillStepRunner projectId="deal-1" step={STEP} />);

    await screen.findByLabelText(/As of/);
    fireEvent.change(screen.getByLabelText(/As of/), { target: { value: '2026-09-30' } });
    fireEvent.blur(screen.getByLabelText(/As of/));

    await waitFor(() => expect(stepPatchCall()).toBeDefined());
    expect(JSON.parse(stepPatchCall()?.init?.body as string)).toEqual({
      work: { inputs: { asOf: '2026-09-30' } },
    });
  });

  it('maps a stream 422 problem to its field, and lists an unmatched problem above the button', async () => {
    state.streamStatus = 422;
    state.streamBody = {
      error: {
        code: 'validation',
        detail: {
          problems: [
            { name: 'asOf', message: 'expected a date' },
            { name: null, message: 'bad' },
            { name: 'otherField', message: 'not declared by this skill' },
          ],
        },
      },
    };

    render(<SkillStepRunner projectId="deal-1" step={STEP} />);

    await screen.findByLabelText(/As of/);
    fireEvent.change(screen.getByLabelText(/As of/), { target: { value: '2026-09-30' } });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: DRAFT_BUTTON })).not.toBeDisabled(),
    );

    const draftButton = screen.getByRole('button', { name: DRAFT_BUTTON });
    fireEvent.click(draftButton);

    expect(await screen.findByText('expected a date')).toBeInTheDocument();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('bad');
    expect(alert).toHaveTextContent('otherField: not declared by this skill');
    expect(alert.compareDocumentPosition(draftButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(recordCall()).toBeUndefined();
  });

  it('falls through to the generic failure and records it when a 422 has no usable problems', async () => {
    state.streamStatus = 422;
    state.streamBody = {
      error: { code: 'validation', detail: { problems: [] } },
    };

    render(<SkillStepRunner projectId="deal-1" step={STEP} />);

    await screen.findByLabelText(/As of/);
    fireEvent.change(screen.getByLabelText(/As of/), { target: { value: '2026-09-30' } });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: DRAFT_BUTTON })).not.toBeDisabled(),
    );

    fireEvent.click(screen.getByRole('button', { name: DRAFT_BUTTON }));

    await waitFor(() => expect(recordCall()).toBeDefined());
    const recorded = JSON.parse(recordCall()?.init?.body as string) as Record<string, unknown>;
    expect(recorded.outcome).toBe('failed');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The run stopped before it finished. Nothing was filed on this step.',
    );
    expect(screen.queryByText('expected a date')).not.toBeInTheDocument();
  });

  it("labels a past run's field values from the version it used, even when a different version is selected", async () => {
    const versionB = { kind: 'mount', name: 'weekly-update', version: 2, digest: 'b'.repeat(64) };
    const audienceField = {
      name: 'audience',
      type: 'enum',
      label: 'Audience',
      description: null,
      values: ['board', 'committee'],
      required: false,
      default: 'board',
    };
    state.extraCatalogOptions = [
      {
        reference: versionB,
        label: 'v2',
        authorName: null,
        createdAt: null,
        available: true,
        unavailableReason: null,
        inputs: [audienceField],
      },
    ];
    state.runs = [
      runRow({
        id: 'run-a',
        inputs: { asOf: '2026-09-30' },
        input: null,
        resultText: 'result a',
        binding: state.versionsCurrent,
      }),
    ];

    render(<SkillStepRunner projectId="deal-1" step={STEP} />);

    const select = await screen.findByLabelText('Skill version');
    const optionB = screen.getByRole('option', { name: /v2/ }) as HTMLOptionElement;
    fireEvent.change(select, { target: { value: optionB.value } });

    await waitFor(() => expect(screen.getByLabelText('Audience')).toBeInTheDocument());

    const term = await screen.findByText('As of', { selector: 'dt' });
    expect(term.nextElementSibling).toHaveTextContent('2026-09-30');
  });

  it("falls back to the field name, not the currently selected version's label, when the run's own version is not listed", async () => {
    state.currentInputs = [
      {
        name: 'asOf',
        type: 'date',
        label: 'Snapshot date',
        description: null,
        values: [],
        required: false,
        default: null,
      },
    ];
    const unlistedBinding = {
      kind: 'mount',
      name: 'weekly-update',
      version: 99,
      digest: 'c'.repeat(64),
    };
    state.runs = [
      runRow({
        id: 'run-unlisted',
        inputs: { asOf: '2026-09-30' },
        input: null,
        resultText: 'result unlisted',
        binding: unlistedBinding,
      }),
    ];

    render(<SkillStepRunner projectId="deal-1" step={STEP} />);

    await screen.findByLabelText(/Snapshot date/);

    const term = await screen.findByText('asOf', { selector: 'dt' });
    expect(term.nextElementSibling).toHaveTextContent('2026-09-30');
    expect(screen.queryByText('Snapshot date', { selector: 'dt' })).not.toBeInTheDocument();
  });

  it('shows run inputs in declared field order even when the stored object has a different key order', async () => {
    const audienceField = {
      name: 'audience',
      type: 'enum',
      label: 'Audience',
      description: null,
      values: ['board', 'committee'],
      required: false,
      default: 'board',
    };
    state.currentInputs = [AS_OF_FIELD, audienceField];
    state.runs = [
      runRow({
        id: 'run-reordered',
        inputs: { audience: 'board', asOf: '2026-09-30' },
        input: null,
        resultText: 'result reordered',
        binding: state.versionsCurrent,
      }),
    ];

    render(<SkillStepRunner projectId="deal-1" step={STEP} />);

    const summary = await screen.findByLabelText('Run inputs');
    const terms = Array.from(summary.querySelectorAll('dt')).map((node) => node.textContent);
    expect(terms).toEqual(['As of', 'Audience']);
  });

  it("shows a past run's field values and instructions when selected, and neither block when both are empty", async () => {
    state.runs = [
      runRow({
        id: 'run-with-inputs',
        inputs: { asOf: '2026-09-30' },
        input: 'Short',
        resultText: 'first result',
        binding: state.versionsCurrent,
      }),
      runRow({
        id: 'run-without-inputs',
        actorName: 'Ana Reyes',
        inputs: {},
        input: null,
        resultText: 'second result',
        createdAt: '2026-09-14T10:00:00.000Z',
        binding: state.versionsCurrent,
      }),
    ];

    render(<SkillStepRunner projectId="deal-1" step={STEP} />);

    const term = await screen.findByText('As of', { selector: 'dt' });
    expect(term.nextElementSibling).toHaveTextContent('2026-09-30');
    expect(screen.getByText('Short')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Ana Reyes/ }));

    expect(screen.queryByText('As of', { selector: 'dt' })).not.toBeInTheDocument();
    expect(screen.queryByText('Short')).not.toBeInTheDocument();
  });

  it('shows only Additional instructions for a legacy run with no field values', async () => {
    state.runs = [
      runRow({
        id: 'run-legacy',
        inputs: {},
        input: 'Old text',
        resultText: 'legacy result',
      }),
    ];

    render(<SkillStepRunner projectId="deal-1" step={STEP} />);

    const summary = await screen.findByLabelText('Run inputs');
    expect(summary).toHaveTextContent(`${INSTRUCTIONS_LABEL}Old text`);
    expect(screen.queryByText('As of', { selector: 'dt' })).not.toBeInTheDocument();
  });

  it('shows no run-inputs summary for a fully empty run', async () => {
    state.runs = [
      runRow({
        id: 'run-empty',
        actorName: 'Ana Reyes',
        inputs: {},
        input: null,
        resultText: 'empty result',
        createdAt: '2026-09-14T10:00:00.000Z',
      }),
    ];

    render(<SkillStepRunner projectId="deal-1" step={STEP} />);

    await screen.findByText('empty result');
    expect(screen.queryByLabelText('Run inputs')).not.toBeInTheDocument();
  });
});
