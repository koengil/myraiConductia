import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { RailTemplatePicker } from '@/components/wizard/RailTemplatePicker';
import type {
  TemplatePreview,
  TemplateSelection,
  TemplateSummary,
} from '@/lib/railTemplates/types';

const TEMPLATE: TemplateSummary = {
  id: '33333333-3333-4333-8333-333333333333',
  revisionId: '44444444-4444-4444-8444-444444444444',
  name: 'Technology sell-side',
  description: 'Standard technology process.',
  stepCount: 3,
  skillCount: 1,
  updatedAt: '2026-09-20T12:00:00.000Z',
};

const OTHER: TemplateSummary = {
  ...TEMPLATE,
  id: '55555555-5555-4555-8555-555555555555',
  revisionId: '66666666-6666-4666-8666-666666666666',
  name: 'Healthcare carve-out',
  description: '',
};

const PREVIEW: TemplatePreview = {
  ...TEMPLATE,
  steps: [
    { title: 'Buyer list', phaseIndex: 2, displayOrder: 1 },
    { title: 'Teaser', phaseIndex: 1, displayOrder: 2 },
    { title: 'Mandate kickoff', phaseIndex: 1, displayOrder: 1 },
  ],
};

const selectionOf = (summary: TemplateSummary): TemplateSelection => ({
  templateId: summary.id,
  revisionId: summary.revisionId,
});

type Reply = { status: number; body: unknown };

let listReplies: Reply[] = [];
let previewReplies: Reply[] = [];
let calls: string[] = [];

function installFetch() {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const reply = url.startsWith('/api/v1/rail-templates?')
      ? (listReplies.shift() ?? { status: 200, body: { templates: [] } })
      : (previewReplies.shift() ?? { status: 404, body: { error: 'nope' } });
    return {
      ok: reply.status < 400,
      status: reply.status,
      json: async () => reply.body,
    } as Response;
  }) as unknown as typeof fetch;
}

function renderPicker(value: TemplateSelection | null = null) {
  const onChange = vi.fn();
  render(<RailTemplatePicker value={value} onChange={onChange} />);
  return onChange;
}

const railSelect = () => screen.getByRole('combobox', { name: 'Rail' });

const previewCard = () =>
  screen.getByRole('list', { name: 'Saved rail steps' })
    .parentElement as HTMLElement;

beforeEach(() => {
  listReplies = [{ status: 200, body: { templates: [TEMPLATE, OTHER] } }];
  previewReplies = [{ status: 200, body: PREVIEW }];
  calls = [];
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('RailTemplatePicker', () => {
  it('keeps the default rail as the explicit initial choice', async () => {
    render(<RailTemplatePicker value={null} onChange={vi.fn()} />);
    expect(screen.getByRole('combobox', { name: 'Rail' })).toHaveValue('standard');
  });

  it('lists the company saved rails beside the default rail, which stays the choice', async () => {
    const onChange = renderPicker();
    await screen.findByRole('option', { name: 'Technology sell-side' });
    expect(
      within(railSelect()).getByRole('option', { name: 'Default rail' }),
    ).toBeInTheDocument();
    expect(
      within(railSelect()).getByRole('option', { name: 'Healthcare carve-out' }),
    ).toBeInTheDocument();
    expect(calls[0]).toBe('/api/v1/rail-templates?purpose=use');
    expect(railSelect()).toHaveValue('standard');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('reports the chosen rail with the revision captured from the list', async () => {
    const onChange = renderPicker();
    await screen.findByRole('option', { name: 'Technology sell-side' });

    fireEvent.change(railSelect(), { target: { value: TEMPLATE.id } });

    expect(onChange).toHaveBeenCalledWith({
      templateId: TEMPLATE.id,
      revisionId: TEMPLATE.revisionId,
    });
  });

  it('returns to the default rail as an explicit choice', async () => {
    const onChange = renderPicker(selectionOf(TEMPLATE));
    await screen.findByRole('option', { name: 'Technology sell-side' });

    fireEvent.change(railSelect(), { target: { value: 'standard' } });

    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('previews the saved rail name, description and steps in phase order', async () => {
    const onChange = renderPicker(selectionOf(TEMPLATE));

    const steps = await screen.findByRole('list', { name: 'Saved rail steps' });
    expect(
      within(steps)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Mandate kickoff', 'Teaser', 'Buyer list']);
    expect(screen.getByText('Standard technology process.')).toBeVisible();
    expect(previewCard()).toHaveTextContent('3 steps across 2 phases.');
    expect(previewCard().querySelectorAll('p')).toHaveLength(3);
    expect(calls).toContain(`/api/v1/rail-templates/${TEMPLATE.id}`);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('omits the description when the saved rail has none', async () => {
    previewReplies = [{ status: 200, body: { ...OTHER, steps: PREVIEW.steps } }];
    renderPicker(selectionOf(OTHER));

    await screen.findByRole('list', { name: 'Saved rail steps' });
    expect(previewCard()).toHaveTextContent(OTHER.name);
    expect(previewCard().querySelectorAll('p')).toHaveLength(2);
  });

  it('sends the revision it previewed when the rail changed before the preview', async () => {
    previewReplies = [
      { status: 200, body: { ...PREVIEW, revisionId: 'later-revision' } },
    ];
    const onChange = renderPicker(selectionOf(TEMPLATE));

    await screen.findByRole('list', { name: 'Saved rail steps' });
    expect(onChange).toHaveBeenCalledWith({
      templateId: TEMPLATE.id,
      revisionId: 'later-revision',
    });
  });

  it('says so when the saved rail cannot be previewed', async () => {
    previewReplies = [{ status: 503, body: { error: 'down', retryable: true } }];
    renderPicker(selectionOf(TEMPLATE));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This saved rail could not be previewed.',
    );
    expect(railSelect()).toHaveValue(TEMPLATE.id);
  });

  it('shows an error and a Retry when the saved rails cannot be listed, and still offers the default rail', async () => {
    listReplies = [{ status: 500, body: { error: 'boom' } }];
    renderPicker();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Your company's saved rails could not be loaded.",
    );
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
    expect(railSelect()).toHaveValue('standard');
    expect(
      within(railSelect()).getByRole('option', { name: 'Default rail' }),
    ).toBeInTheDocument();
  });

  it('reloads the saved rails on Retry', async () => {
    listReplies = [
      { status: 500, body: { error: 'boom' } },
      { status: 200, body: { templates: [TEMPLATE] } },
    ];
    renderPicker();

    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('option', { name: 'Technology sell-side' })).toBeInTheDocument();
    expect(
      screen.queryByText("Your company's saved rails could not be loaded."),
    ).not.toBeInTheDocument();
  });

  it('says no company rail is published yet and points to Rails configuration', async () => {
    listReplies = [{ status: 200, body: { templates: [] } }];
    renderPicker();

    expect(
      await screen.findByText('No published company rails yet. Publish one in Rails configuration.'),
    ).toBeVisible();
    expect(railSelect()).toHaveValue('standard');
  });

  it('announces the list read while it is in flight', async () => {
    renderPicker();
    expect(screen.getByRole('status')).toHaveTextContent(
      "Reading your company's saved rails.",
    );
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  });
});
