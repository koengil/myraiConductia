import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DRAFT_BUTTON } from './helpers/draftButton';

import { SkillStepRunner } from '@/components/rail/SkillStepRunner';
import type { ProjectRailStep } from '@/lib/rail/projectRail';

const BINDING = {
  skillId: '2d362e20-0709-4ba0-bbd7-d21831148282',
  versionId: '0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6',
  digest: 'a'.repeat(64),
};

const CURRENT_REFERENCE = {
  kind: 'publication',
  skillId: BINDING.skillId,
  versionId: BINDING.versionId,
  digest: BINDING.digest,
};

const OLDER_REFERENCE = {
  kind: 'publication',
  skillId: BINDING.skillId,
  versionId: '11111111-1111-4111-8111-111111111111',
  digest: 'b'.repeat(64),
};

const PRUNED_REFERENCE = {
  kind: 'mount',
  name: 'acme-teaser',
  version: 3,
  digest: 'c'.repeat(64),
};

const AVAILABLE_CATALOG_REFERENCE = {
  kind: 'mount',
  name: 'acme-teaser',
  version: 4,
  digest: 'd'.repeat(64),
};

const RUN_ID = '3f0d6f9a-1f4c-4a2f-9f37-2f8f2c0f6f11';
const HUMAN_STEP_ID = 'custom:0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6';
const DEAL_STEP_UUID = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b';

const PRUNED_REASON = 'This catalog version no longer keeps its bytes.';
const PROJECT_UNAVAILABLE_REASON = "This project's skill version history could not be read.";

const ASOF_FIELD = {
  name: 'asOf',
  type: 'date',
  label: 'As of',
  description: null,
  values: [],
  required: true,
  default: null,
};

const LEGACY_FIELD = {
  name: 'legacy',
  type: 'string',
  label: 'Legacy note',
  description: null,
  values: [],
  required: false,
  default: null,
};

const AUDIENCE_FIELD = {
  name: 'audience',
  type: 'enum',
  label: 'Audience',
  description: null,
  values: ['board', 'committee'],
  required: false,
  default: 'board',
};

const STEP: ProjectRailStep = {
  id: DEAL_STEP_UUID,
  stepId: HUMAN_STEP_ID,
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

const STEP_VERSIONS = {
  project: [
    {
      reference: CURRENT_REFERENCE,
      label: 'Published 12 Sep 2026',
      authorName: 'Storm Duncan',
      createdAt: '2026-09-12T10:00:00.000Z',
      available: true,
      unavailableReason: null,
      inputs: [],
    },
    {
      reference: OLDER_REFERENCE,
      label: 'Published 1 Sep 2026',
      authorName: 'Ana Reyes',
      createdAt: '2026-09-01T10:00:00.000Z',
      available: true,
      unavailableReason: null,
      inputs: [],
    },
  ],
  projectUnavailableReason: null,
  catalog: [
    {
      reference: AVAILABLE_CATALOG_REFERENCE,
      label: 'v4',
      authorName: 'Ops bot',
      createdAt: '2026-08-20T10:00:00.000Z',
      available: true,
      unavailableReason: null,
      inputs: [],
    },
    {
      reference: PRUNED_REFERENCE,
      label: 'v3',
      authorName: 'Ops bot',
      createdAt: '2026-08-01T10:00:00.000Z',
      available: false,
      unavailableReason: PRUNED_REASON,
      inputs: [],
    },
  ],
  ancestorContract: null,
};

function sseBody(text: string, done: Record<string, unknown> = { costUsd: 0.2 }): ReadableStream<Uint8Array> {
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
        encoder.encode(`event: done\ndata: ${JSON.stringify({ type: 'done', ...done })}\n\n`),
      );
      controller.close();
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

type Call = { url: string; init?: RequestInit };

const calls: Call[] = [];
const state = {
  work: { primary: 'Summarise the week' } as Record<string, unknown>,
  runs: [] as Record<string, unknown>[],
  streamStatus: 200,
  streamText: 'Here is the update.',
  current: CURRENT_REFERENCE as Record<string, unknown>,
  versionsPayload: STEP_VERSIONS as Record<string, unknown>,
  versionsStatus: 200,
  bindingStatus: 200,
  bindingError: '',
  doneFrame: { costUsd: 0.2 } as Record<string, unknown>,
};

function isVersions(url: string): boolean {
  return url.endsWith('/skill-versions');
}

function isBinding(url: string): boolean {
  return url.endsWith('/skill-binding');
}

function isStream(url: string): boolean {
  return url.endsWith('/skill-runs/stream');
}

function isRuns(url: string): boolean {
  return url.endsWith('/skill-runs');
}

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (isVersions(url)) {
        return state.versionsStatus === 200
          ? new Response(JSON.stringify({ ...state.versionsPayload, current: state.current }), {
              status: 200,
            })
          : new Response(JSON.stringify({ error: 'nope' }), { status: state.versionsStatus });
      }
      if (isBinding(url) && init?.method === 'PUT') {
        if (state.bindingStatus !== 200) {
          return new Response(JSON.stringify({ error: state.bindingError }), {
            status: state.bindingStatus,
          });
        }
        const body = JSON.parse(init.body as string) as { reference: Record<string, unknown> };
        state.current = body.reference;
        return new Response(JSON.stringify({ binding: body.reference }), { status: 200 });
      }
      if (isStream(url)) {
        return state.streamStatus === 200
          ? new Response(sseBody(state.streamText, state.doneFrame), { status: 200 })
          : new Response(JSON.stringify({ error: 'nope' }), { status: state.streamStatus });
      }
      if (isRuns(url) && init?.method === 'POST') {
        const sent = JSON.parse(init.body as string) as Record<string, unknown>;
        const stored = runRow({
          id: sent.runId,
          outcome: sent.outcome,
          input: sent.input,
          resultText: sent.resultText ?? null,
          errorMessage: sent.errorMessage ?? null,
          createdAt: '2026-09-14T12:00:00.000Z',
          model: sent.model ?? null,
          clampedFrom: sent.clampedFrom ?? null,
        });
        state.runs = [stored, ...state.runs];
        return new Response(JSON.stringify({ run: stored }), { status: 201 });
      }
      if (isRuns(url)) {
        return new Response(JSON.stringify({ runs: state.runs }), { status: 200 });
      }
      return new Response(JSON.stringify({ step: { work: state.work } }), { status: 200 });
    }),
  );
}

function findOptionByText(container: HTMLElement, text: string): HTMLOptionElement {
  const option = Array.from(container.querySelectorAll('option')).find((entry) =>
    entry.textContent?.includes(text),
  );
  if (!option) throw new Error(`No option found containing "${text}"`);
  return option;
}

beforeEach(() => {
  calls.length = 0;
  state.work = { primary: 'Summarise the week' };
  state.runs = [];
  state.streamStatus = 200;
  state.streamText = 'Here is the update.';
  state.current = CURRENT_REFERENCE;
  state.versionsPayload = STEP_VERSIONS;
  state.versionsStatus = 200;
  state.bindingStatus = 200;
  state.bindingError = '';
  state.doneFrame = { costUsd: 0.2 };
  vi.stubGlobal('crypto', { ...globalThis.crypto, randomUUID: () => RUN_ID });
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SkillStepRunner version control', () => {
  it('fetches versions using the human step key, not the deal step UUID', async () => {
    render(<SkillStepRunner projectId="deal-1" step={STEP} />);

    await screen.findByLabelText('Skill version');

    const versionsCall = calls.find((call) => isVersions(call.url));
    expect(versionsCall?.url).toContain(encodeURIComponent(HUMAN_STEP_ID));
    expect(versionsCall?.url).not.toContain(DEAL_STEP_UUID);
  });

  it("shows the control's value as the bound version, labelled with its author and date", async () => {
    render(<SkillStepRunner projectId="deal-1" step={STEP} />);

    const select = (await screen.findByLabelText('Skill version')) as HTMLSelectElement;
    await waitFor(() => {
      const chosen = select.options[select.selectedIndex];
      expect(chosen.textContent).toContain('Published 12 Sep 2026');
      expect(chosen.textContent).toContain('Storm Duncan');
    });
  });

  it('groups versions into This project and Firm catalog', async () => {
    const { container } = render(<SkillStepRunner projectId="deal-1" step={STEP} />);
    await screen.findByLabelText('Skill version');

    const projectGroup = container.querySelector('optgroup[label="This project"]');
    const catalogGroup = container.querySelector('optgroup[label="Firm catalog"]');
    expect(projectGroup).toBeTruthy();
    expect(catalogGroup).toBeTruthy();
    expect(projectGroup?.querySelectorAll('option').length).toBe(2);
    expect(catalogGroup?.querySelectorAll('option').length).toBe(2);

    const projectOptionText = Array.from(projectGroup?.querySelectorAll('option') ?? []).map(
      (option) => option.textContent,
    );
    expect(projectOptionText[0]).toContain('Published 12 Sep 2026');
    expect(projectOptionText[1]).toContain('Published 1 Sep 2026');

    const catalogOptionText = Array.from(catalogGroup?.querySelectorAll('option') ?? []).map(
      (option) => option.textContent,
    );
    expect(catalogOptionText[0]).toContain('v4');
    expect(catalogOptionText[1]).toContain('v3');
  });

  it('lists a pruned catalog version, disabled, with its reason', async () => {
    const { container } = render(<SkillStepRunner projectId="deal-1" step={STEP} />);
    await screen.findByLabelText('Skill version');

    const prunedOption = findOptionByText(container, 'v3');
    expect(prunedOption.disabled).toBe(true);
    expect(prunedOption.textContent).toContain(PRUNED_REASON);

    const availableOption = findOptionByText(container, 'v4');
    expect(availableOption.disabled).toBe(false);
  });

  it('runs a selected version once, sending it on the stream request, without rebinding', async () => {
    const { container } = render(<SkillStepRunner projectId="deal-1" step={STEP} />);
    const select = (await screen.findByLabelText('Skill version')) as HTMLSelectElement;
    await waitFor(() => expect(select.value).not.toBe(''));

    const olderOption = findOptionByText(container, 'Ana Reyes');
    fireEvent.change(select, { target: { value: olderOption.value } });

    fireEvent.click(screen.getByRole('button', { name: DRAFT_BUTTON }));

    await waitFor(() => expect(screen.getByText('Here is the update.')).toBeInTheDocument());

    const streamCall = calls.find((call) => isStream(call.url));
    const sentBody = JSON.parse(streamCall?.init?.body as string) as { version?: unknown };
    expect(sentBody.version).toEqual(OLDER_REFERENCE);

    expect(calls.some((call) => isBinding(call.url) && call.init?.method === 'PUT')).toBe(false);
  });

  it('rebinds only when Use on this step is chosen', async () => {
    const { container } = render(<SkillStepRunner projectId="deal-1" step={STEP} />);
    const select = (await screen.findByLabelText('Skill version')) as HTMLSelectElement;
    await waitFor(() => expect(select.value).not.toBe(''));

    const olderOption = findOptionByText(container, 'Ana Reyes');
    fireEvent.change(select, { target: { value: olderOption.value } });

    const useButton = await screen.findByRole('button', { name: 'Use on this step' });
    fireEvent.click(useButton);

    await waitFor(() =>
      expect(calls.some((call) => isBinding(call.url) && call.init?.method === 'PUT')).toBe(true),
    );
    const bindingCall = calls.find((call) => isBinding(call.url) && call.init?.method === 'PUT');
    expect(JSON.parse(bindingCall?.init?.body as string)).toEqual({ reference: OLDER_REFERENCE });

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Use on this step' })).not.toBeInTheDocument(),
    );
    const versionsCalls = calls.filter((call) => isVersions(call.url));
    expect(versionsCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('calls onEnhance with the run id from a history entry', async () => {
    state.runs = [runRow()];
    const onEnhance = vi.fn();

    render(<SkillStepRunner projectId="deal-1" step={STEP} onEnhance={onEnhance} />);

    const button = await screen.findByRole('button', { name: 'Improve this skill' });
    fireEvent.click(button);

    expect(onEnhance).toHaveBeenCalledWith('run-2');
  });

  it('calls onEnhance with null from the control when the step has no runs', async () => {
    const onEnhance = vi.fn();

    render(<SkillStepRunner projectId="deal-1" step={STEP} onEnhance={onEnhance} />);

    const button = await screen.findByRole('button', { name: 'Improve this skill' });
    fireEvent.click(button);

    expect(onEnhance).toHaveBeenCalledWith(null);
  });

  it('sends the chosen model alias on the stream request', async () => {
    render(<SkillStepRunner projectId="deal-1" step={STEP} />);
    await screen.findByLabelText('Skill version');

    const modelSelect = screen.getByLabelText('Model') as HTMLSelectElement;
    fireEvent.change(modelSelect, { target: { value: 'opus' } });

    fireEvent.click(screen.getByRole('button', { name: DRAFT_BUTTON }));

    await waitFor(() => expect(screen.getByText('Here is the update.')).toBeInTheDocument());

    const streamCall = calls.find((call) => isStream(call.url));
    expect(JSON.parse(streamCall?.init?.body as string).model).toBe('opus');
  });

  it('records the version and the model the run actually used, not the step binding', async () => {
    const { container } = render(<SkillStepRunner projectId="deal-1" step={STEP} />);
    const select = (await screen.findByLabelText('Skill version')) as HTMLSelectElement;
    await waitFor(() => expect(select.value).not.toBe(''));

    const olderOption = findOptionByText(container, 'Ana Reyes');
    fireEvent.change(select, { target: { value: olderOption.value } });
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'opus' } });

    fireEvent.click(screen.getByRole('button', { name: DRAFT_BUTTON }));

    await waitFor(() => expect(screen.getByText('Here is the update.')).toBeInTheDocument());

    const recordCall = calls.find((call) => isRuns(call.url) && call.init?.method === 'POST');
    const recorded = JSON.parse(recordCall?.init?.body as string) as Record<string, unknown>;
    expect(recorded.reference).toEqual(OLDER_REFERENCE);
    expect(recorded.model).toBe('opus');
  });

  it('records the version and the model on a failed run too', async () => {
    state.streamStatus = 502;
    const { container } = render(<SkillStepRunner projectId="deal-1" step={STEP} />);
    const select = (await screen.findByLabelText('Skill version')) as HTMLSelectElement;
    await waitFor(() => expect(select.value).not.toBe(''));

    const olderOption = findOptionByText(container, 'Ana Reyes');
    fireEvent.change(select, { target: { value: olderOption.value } });
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'haiku' } });

    fireEvent.click(screen.getByRole('button', { name: DRAFT_BUTTON }));

    await waitFor(() =>
      expect(calls.some((call) => isRuns(call.url) && call.init?.method === 'POST')).toBe(true),
    );
    const recordCall = calls.find((call) => isRuns(call.url) && call.init?.method === 'POST');
    const recorded = JSON.parse(recordCall?.init?.body as string) as Record<string, unknown>;
    expect(recorded.outcome).toBe('failed');
    expect(recorded.reference).toEqual(OLDER_REFERENCE);
    expect(recorded.model).toBe('haiku');
  });

  it('shows the project lineage failure reason when the project history could not be read', async () => {
    state.versionsPayload = {
      ...STEP_VERSIONS,
      project: [],
      projectUnavailableReason: PROJECT_UNAVAILABLE_REASON,
    };

    render(<SkillStepRunner projectId="deal-1" step={STEP} />);
    await screen.findByLabelText('Skill version');

    expect(await screen.findByText(PROJECT_UNAVAILABLE_REASON)).toBeInTheDocument();
  });

  it('does not show the project lineage failure reason when the project list is simply empty', async () => {
    state.versionsPayload = {
      ...STEP_VERSIONS,
      project: [],
      projectUnavailableReason: null,
    };

    render(<SkillStepRunner projectId="deal-1" step={STEP} />);
    await screen.findByLabelText('Skill version');

    expect(screen.queryByText(PROJECT_UNAVAILABLE_REASON)).not.toBeInTheDocument();
  });

  it('records the model the run was clamped to, not the one that was asked for', async () => {
    state.doneFrame = { costUsd: 0.2, model: 'haiku', clampedFrom: 'opus' };

    render(<SkillStepRunner projectId="deal-1" step={STEP} />);
    await screen.findByLabelText('Skill version');
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'opus' } });

    fireEvent.click(screen.getByRole('button', { name: DRAFT_BUTTON }));
    await waitFor(() => expect(screen.getByText('Here is the update.')).toBeInTheDocument());

    const recordCall = calls.find((call) => isRuns(call.url) && call.init?.method === 'POST');
    const sent = JSON.parse(recordCall?.init?.body as string) as Record<string, unknown>;
    expect(sent.model).toBe('haiku');
    expect(sent.clampedFrom).toBe('opus');
  });

  it('says under the model select that the run was clamped, and to what', async () => {
    state.doneFrame = { costUsd: 0.2, model: 'haiku', clampedFrom: 'opus' };

    render(<SkillStepRunner projectId="deal-1" step={STEP} />);
    await screen.findByLabelText('Skill version');
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'opus' } });

    fireEvent.click(screen.getByRole('button', { name: DRAFT_BUTTON }));

    expect(
      await screen.findByText("Opus is above this skill's ceiling. The run used Haiku."),
    ).toBeInTheDocument();
  });

  it('says nothing about a ceiling when the run was not clamped', async () => {
    render(<SkillStepRunner projectId="deal-1" step={STEP} />);
    await screen.findByLabelText('Skill version');

    fireEvent.click(screen.getByRole('button', { name: DRAFT_BUTTON }));
    await waitFor(() => expect(screen.getByText('Here is the update.')).toBeInTheDocument());

    expect(screen.queryByText(/above this skill's ceiling/)).toBeNull();
  });

  it('does not read a rewound catalog version as the one the step is pinned to', async () => {
    const rewound = { ...AVAILABLE_CATALOG_REFERENCE, digest: 'e'.repeat(64) };
    state.current = rewound;

    const { container } = render(<SkillStepRunner projectId="deal-1" step={STEP} />);
    await screen.findByLabelText('Skill version');

    await waitFor(() =>
      expect(
        screen.getByText(
          'This step is bound to a version the list no longer offers. Choose a listed version to run.',
        ),
      ).toBeInTheDocument(),
    );

    const select = screen.getByLabelText('Skill version') as HTMLSelectElement;
    const chosen = select.options[select.selectedIndex];
    expect(chosen.textContent).toBe('Bound version, no longer listed');
    expect(findOptionByText(container, 'v4').selected).toBe(false);
  });

  it('surfaces the server message when a rebind is refused', async () => {
    const { container } = render(<SkillStepRunner projectId="deal-1" step={STEP} />);
    const select = (await screen.findByLabelText('Skill version')) as HTMLSelectElement;
    await waitFor(() => expect(select.value).not.toBe(''));

    state.bindingStatus = 422;
    state.bindingError = 'That version is not available for this step';

    const olderOption = findOptionByText(container, 'Ana Reyes');
    fireEvent.change(select, { target: { value: olderOption.value } });
    fireEvent.click(await screen.findByRole('button', { name: 'Use on this step' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That version is not available for this step',
    );
  });

  it('shows a neutral failure state when the version fetch fails outright', async () => {
    state.versionsStatus = 500;

    render(<SkillStepRunner projectId="deal-1" step={STEP} />);

    expect(await screen.findByText('Skill versions are unavailable right now.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Skill version')).not.toBeInTheDocument();
  });

  it('keeps a shared value across a version switch, shows the new default, and drops a field the new version lacks', async () => {
    state.versionsPayload = {
      project: [
        {
          reference: CURRENT_REFERENCE,
          label: 'Published 12 Sep 2026',
          authorName: 'Storm Duncan',
          createdAt: '2026-09-12T10:00:00.000Z',
          available: true,
          unavailableReason: null,
          inputs: [ASOF_FIELD, LEGACY_FIELD],
        },
        {
          reference: OLDER_REFERENCE,
          label: 'Published 1 Sep 2026',
          authorName: 'Ana Reyes',
          createdAt: '2026-09-01T10:00:00.000Z',
          available: true,
          unavailableReason: null,
          inputs: [ASOF_FIELD, AUDIENCE_FIELD],
        },
      ],
      projectUnavailableReason: null,
      catalog: [],
      ancestorContract: null,
    };
    state.current = CURRENT_REFERENCE;
    state.work = { inputs: { asOf: '2026-09-01', legacy: 'stale note' } };

    const { container } = render(<SkillStepRunner projectId="deal-1" step={STEP} />);

    await waitFor(() =>
      expect((screen.getByLabelText(/As of/) as HTMLInputElement).value).toBe('2026-09-01'),
    );

    const olderOption = findOptionByText(container, 'Ana Reyes');
    fireEvent.change(await screen.findByLabelText('Skill version'), {
      target: { value: olderOption.value },
    });

    await waitFor(() =>
      expect((screen.getByLabelText(/As of/) as HTMLInputElement).value).toBe('2026-09-01'),
    );
    expect(screen.queryByLabelText(/Legacy note/)).not.toBeInTheDocument();
    expect((screen.getByLabelText('Audience') as HTMLSelectElement).value).toBe('board');

    fireEvent.click(screen.getByRole('button', { name: DRAFT_BUTTON }));

    await waitFor(() => expect(screen.getByText('Here is the update.')).toBeInTheDocument());

    const streamCall = calls.find((call) => isStream(call.url));
    const sentBody = JSON.parse(streamCall?.init?.body as string) as Record<string, unknown>;
    expect(sentBody.inputs).toEqual({ asOf: '2026-09-01', audience: 'board' });
  });
});
