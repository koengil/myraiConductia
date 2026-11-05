import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { MVP_DEAL_RAIL, orderedSteps, phaseForStep } from '@/lib/rail/dealRail';
import type { DealStepRecord } from '@/lib/rail/dealStepRecord';
import { MANUAL_STEP_IDS } from '@/lib/rail/manualStepDefs';
import type { ProjectRail, ProjectRailStep } from '@/lib/rail/projectRail';
import { PhaseColumn } from '@/components/rail/PhaseColumn';
import { foldedPriorSteps, foldedSteps } from '@/components/rail/RailBoard';
import { stepStateForStep } from '@/components/rail/stepState';
import {
  initialsOf,
  ownersFromStepRecords,
  phaseSummaries,
  railHeaderProgress,
  shortPhaseName,
} from '@/components/rail/railBoardModel';

/*
 * The rail board and its zoom (R2–R4): phases left to right as large cards
 * that open into stacked steps, one step zoomed in with its neighbours, and
 * the ways back out (button, Escape, ctrl-wheel, pinch).
 */

const PHASES = MVP_DEAL_RAIL.map((p) => ({ index: p.index, name: p.name, dealStatus: p.dealStatus }));
const catalog = orderedSteps(MVP_DEAL_RAIL);
const phaseOf = (stepId: string) => phaseForStep(stepId, MVP_DEAL_RAIL)?.index ?? 1;

function row(
  index: number,
  status: ProjectRailStep['status'],
  overrides: Partial<ProjectRailStep> = {},
): ProjectRailStep {
  const step = catalog[index];
  return {
    id: `uuid-${index + 1}`,
    stepId: step.id,
    origin: 'catalog',
    phaseIndex: phaseOf(step.id),
    displayOrder: index + 1,
    seq: step.seq,
    status,
    definition: null,
    anchorStepId: null,
    removedAt: null,
    removedBy: null,
    skip: null,
    catalog: step,
    ...overrides,
  };
}

function record(stepId: string, assignedToName: string | null): DealStepRecord {
  return {
    stepId,
    seq: 0,
    status: 'pending',
    assignedTo: assignedToName ? `user-${assignedToName.toLowerCase().replace(/\s+/g, '-')}` : null,
    assignedToName,
    completedBy: null,
    completedByName: null,
    completedAt: null,
    completionNote: null,
    skip: null,
  };
}

describe('rail board model', () => {
  // Origination: one done, one before entry, the cursor, one ahead. Preparation: one done out of order.
  const firstPrep = catalog.findIndex((s) => phaseOf(s.id) === 2);
  const steps = [
    row(0, 'complete'),
    row(1, 'skipped_entry'),
    row(2, 'current'),
    row(3, 'pending'),
    row(firstPrep, 'complete'),
    row(firstPrep + 1, 'pending'),
  ];
  const owners = ownersFromStepRecords([
    record(catalog[2].id, 'Alex Chen'),
    record(catalog[3].id, 'Morgan Vale'),
    record(catalog[0].id, 'Storm Duncan'),
    record(catalog[firstPrep + 1].id, 'Alex Chen'),
  ]);

  it('counts each phase from existing statuses, leaving steps before the entry out', () => {
    const [origination, preparation] = phaseSummaries(PHASES, steps, {
      currentStepId: 'uuid-3',
      owners,
    });
    expect(origination).toMatchObject({ done: 1, total: 3, pct: 33, complete: false });
    expect(origination.currentStep?.id).toBe('uuid-3');
    expect(preparation).toMatchObject({ done: 1, total: 2, pct: 50, currentStep: null });
  });

  it('names the people on a phase\'s open steps once each, never on a closed step', () => {
    const [origination, preparation] = phaseSummaries(PHASES, steps, {
      currentStepId: 'uuid-3',
      owners,
    });
    expect(origination.people).toEqual([
      { id: 'user-alex-chen', name: 'Alex Chen', initials: 'AC' },
      { id: 'user-morgan-vale', name: 'Morgan Vale', initials: 'MV' },
    ]);
    expect(preparation.people).toEqual([{ id: 'user-alex-chen', name: 'Alex Chen', initials: 'AC' }]);
  });

  it('keeps two different owners who share a name as two people', () => {
    const twins = ownersFromStepRecords([
      { ...record(catalog[2].id, 'Sam Lee'), assignedTo: 'user-sam-1' },
      { ...record(catalog[3].id, 'Sam Lee'), assignedTo: 'user-sam-2' },
    ]);
    const [origination] = phaseSummaries(PHASES, steps, { currentStepId: 'uuid-3', owners: twins });
    expect(origination.people).toEqual([
      { id: 'user-sam-1', name: 'Sam Lee', initials: 'SL' },
      { id: 'user-sam-2', name: 'Sam Lee', initials: 'SL' },
    ]);
  });

  it('says nothing about people when the owners read failed', () => {
    const [origination] = phaseSummaries(PHASES, steps, { currentStepId: 'uuid-3', owners, ownersUnknown: true });
    expect(origination.people).toBeNull();
  });

  it('drops phases with no steps and keeps rail order', () => {
    const summaries = phaseSummaries(PHASES, steps, { currentStepId: 'uuid-3' });
    expect(summaries.map((s) => s.phase.index)).toEqual([1, 2]);
  });

  it('writes the one progress line from the phase the deal is in', () => {
    const summaries = phaseSummaries(PHASES, steps, { currentStepId: 'uuid-3' });
    const progress = railHeaderProgress(summaries, steps);
    expect(progress.line).toBe('Origination · 1 of 3 steps done');
    expect(progress).toMatchObject({ done: 2, total: 5, pct: 40 });
  });

  it('falls back to the whole rail when there is no current step', () => {
    const summaries = phaseSummaries(PHASES, steps, { currentStepId: null });
    expect(railHeaderProgress(summaries, steps).line).toBe('2 of 5 steps done');
  });

  it('shortens phase names and initials people', () => {
    expect(shortPhaseName('Preparation & Market Readiness')).toBe('Preparation');
    expect(shortPhaseName('Origination, Qualification & Mandate')).toBe('Origination');
    expect(initialsOf('Alex Chen')).toBe('AC');
    expect(initialsOf('Cher')).toBe('C');
    expect(ownersFromStepRecords([record('p1-s1', null)]).size).toBe(0);
  });
});

describe('done fold', () => {
  const stateOf = (step: ProjectRailStep) => stepStateForStep(step);

  it('folds the done run at the top of a phase with a step still open', () => {
    const steps = [row(0, 'complete'), row(1, 'complete'), row(2, 'complete'), row(3, 'current'), row(4, 'complete')];
    expect(foldedSteps(steps, stateOf).map((s) => s.id)).toEqual(['uuid-1', 'uuid-2', 'uuid-3']);
  });

  it('never counts a skipped or pre-entry step as done', () => {
    const skipped = [row(0, 'complete'), row(1, 'complete'), row(2, 'skipped'), row(3, 'current')];
    expect(foldedSteps(skipped, stateOf).map((s) => s.id)).toEqual(['uuid-1', 'uuid-2']);
    const prior = [row(0, 'skipped_entry'), row(1, 'complete'), row(2, 'complete'), row(3, 'current')];
    expect(foldedSteps(prior, stateOf)).toEqual([]);
  });

  it('leaves a single closed card, a finished phase and an untouched phase unfolded', () => {
    expect(foldedSteps([row(0, 'complete'), row(1, 'current')], stateOf)).toEqual([]);
    expect(foldedSteps([row(0, 'complete'), row(1, 'complete')], stateOf)).toEqual([]);
    expect(foldedSteps([row(0, 'pending'), row(1, 'pending')], stateOf)).toEqual([]);
  });

  it('folds the first run of steps from before the deal, when it is long enough', () => {
    const stateOf = (s: { status: string }) => (s.status === 'skipped_entry' ? 'prior' : 'todo') as never;
    const run = [row(0, 'skipped_entry'), row(1, 'skipped_entry'), row(2, 'pending'), row(3, 'skipped_entry')];
    expect(foldedPriorSteps(run, stateOf).map((s) => s.id)).toEqual(['uuid-1', 'uuid-2']);
    expect(foldedPriorSteps([row(0, 'skipped_entry'), row(1, 'pending')], stateOf)).toEqual([]);
    expect(foldedPriorSteps([row(0, 'pending')], stateOf)).toEqual([]);
  });

  it('shows "N done" and unfolds from the toggle', () => {
    const [summary] = phaseSummaries(PHASES, [row(0, 'current')], { currentStepId: 'uuid-1' });
    const onToggle = vi.fn();
    render(
      <ol>
        <PhaseColumn summary={summary} expanded onToggle={() => {}} fold={{ count: 10, open: false, onToggle }}>
          <li>step</li>
        </PhaseColumn>
      </ol>,
    );
    const fold = screen.getByRole('button', { name: '10 done' });
    expect(fold).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(fold);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});

describe('PhaseColumn', () => {
  it('shows the phase name, percent done, "N of M done", the current step and who is on it', () => {
    const steps = [row(0, 'complete'), row(2, 'current'), row(3, 'pending')];
    const [summary] = phaseSummaries(PHASES, steps, {
      currentStepId: 'uuid-3',
      owners: ownersFromStepRecords([record(catalog[2].id, 'Alex Chen')]),
    });
    const onToggle = vi.fn();
    render(
      <ol>
        <PhaseColumn summary={summary} expanded={false} onToggle={onToggle}>
          <li>step</li>
        </PhaseColumn>
      </ol>,
    );
    const toggle = screen.getByRole('button', { name: MVP_DEAL_RAIL[0].name });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAccessibleDescription(/33%\s*1 of 3 done/);
    expect(screen.getByText('Current step')).toBeInTheDocument();
    expect(screen.getByText('Alex Chen')).toBeInTheDocument();
    expect(screen.queryByText('step')).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('lets clicks through the marks that paint over the toggle: open, the rotated chevron sits on top', () => {
    const [summary] = phaseSummaries(PHASES, [row(0, 'current')], { currentStepId: 'uuid-1' });
    const { container } = render(
      <ol>
        <PhaseColumn summary={summary} expanded onToggle={() => {}}>
          <li>step</li>
        </PhaseColumn>
      </ol>,
    );
    const chevron = container.querySelector('svg.lucide-chevron-down');
    expect(chevron).toHaveClass('rotate-180', 'pointer-events-none');
    expect(container.querySelector('h3 + span')).toHaveClass('pointer-events-none');
  });

  it('says so when no one is assigned', () => {
    const [summary] = phaseSummaries(PHASES, [row(0, 'current')], { currentStepId: 'uuid-1' });
    render(
      <ol>
        <PhaseColumn summary={summary} expanded onToggle={() => {}}>
          <li>step</li>
        </PhaseColumn>
      </ol>,
    );
    expect(screen.getByText('No one assigned')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Origination steps' })).toHaveTextContent('step');
  });
});

const state = { rail: null as ProjectRail | null, search: new URLSearchParams() };

const ME = {
  user: {
    id: 'user-1',
    email: 'storm@example.com',
    full_name: 'Storm Duncan',
    display_name: 'Storm Duncan',
    firm_role: null,
    department: null,
    is_external: false,
    status: 'active',
    company_id: null,
    company_role: null,
    can_invite: false,
  },
  company: null,
  mandate: null,
};

vi.mock('@/lib/flags/FlagsContext', () => ({
  useFlag: (key: string) => key === 'project_rail_model',
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ projectId: 'deal-1' }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/projects/deal-1/rail',
  useSearchParams: () => state.search,
}));

describe('DealRail zoom', () => {
  const firstPrep = catalog.findIndex((s) => phaseOf(s.id) === 2);

  beforeEach(() => {
    vi.resetModules();
    state.search = new URLSearchParams();
    // The cursor is the last Origination step; Preparation follows.
    const lastOrigination = firstPrep - 1;
    state.rail = {
      currentStepId: `uuid-${lastOrigination + 1}`,
      canEditStructure: false,
      canSaveTemplate: false,
      phases: PHASES,
      steps: [
        row(lastOrigination - 1, 'complete'),
        row(lastOrigination, 'current'),
        row(firstPrep, 'pending'),
        row(firstPrep + 1, 'pending'),
      ],
    };
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/rail')) return { ok: true, json: async () => state.rail } as Response;
      if (url.includes('/api/v1/me')) return { ok: true, json: async () => ME } as Response;
      return { ok: false, status: 404, json: async () => ({ error: 'Not found' }) } as Response;
    }) as unknown as typeof fetch;
  });

  async function renderRail() {
    const { DealRail } = await import('@/components/rail/DealRail');
    render(<DealRail />);
    await waitFor(() =>
      expect(screen.queryByText(/Loading (the deal rail|your deal list)/i)).not.toBeInTheDocument(),
    );
    return screen.getByRole('region', { name: 'Rail overview' });
  }

  const cursorTitle = () => catalog[firstPrep - 1].title;
  const nextTitle = () => catalog[firstPrep].title;

  async function zoomIntoCursor(board: HTMLElement) {
    fireEvent.click(
      within(board).getByRole('button', { name: new RegExp(`· ${cursorTitle()} · Current step$`) }),
    );
    return screen.findByRole('region', { name: 'Step detail' });
  }

  it('lays the phases out between the two ends of the rail, every phase open', async () => {
    const board = await renderRail();
    expect(board.querySelector('[data-terminal="start"]')).toHaveTextContent('Start');
    expect(board.querySelector('[data-terminal="end"]')).toHaveTextContent('End');
    const open = within(board).getAllByRole('button', { expanded: true });
    expect(open.map((b) => b.textContent)).toEqual([MVP_DEAL_RAIL[0].name, MVP_DEAL_RAIL[1].name]);
    expect(within(board).queryAllByRole('button', { expanded: false })).toEqual([]);
  });

  it('opens with the previous and next steps to walk to, and closing returns focus to the card', async () => {
    const board = await renderRail();
    const zoomed = await zoomIntoCursor(board);
    expect(zoomed).toHaveFocus();
    expect(within(zoomed).getByRole('button', { name: `Next step · ${nextTitle()}` })).toBeInTheDocument();
    expect(within(zoomed).getByText(/In Preparation/)).toBeInTheDocument();

    fireEvent.click(within(zoomed).getByRole('button', { name: 'Zoom out to Origination' }));
    const back = await screen.findByRole('region', { name: 'Rail overview' });
    const phase = within(back).getByRole('button', { name: MVP_DEAL_RAIL[0].name });
    expect(phase).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() =>
      expect(within(back).getByRole('button', { name: new RegExp(`· ${cursorTitle()} · Current step$`) })).toHaveFocus(),
    );
  });

  it('keeps Escape in a text field from closing the step', async () => {
    const board = await renderRail();
    const zoomed = await zoomIntoCursor(board);
    const field = document.createElement('input');
    zoomed.appendChild(field);
    field.focus();
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(screen.getByRole('region', { name: 'Step detail' })).toBeInTheDocument();
    field.remove();
  });

  it('shows the end of the rail beside the last step', async () => {
    state.search = new URLSearchParams(`step=${catalog[firstPrep + 1].seq}`);
    const { DealRail } = await import('@/components/rail/DealRail');
    render(<DealRail />);
    const zoomed = await screen.findByRole('region', { name: 'Step detail' });
    expect(zoomed.querySelector('[data-terminal="end"]')).toHaveTextContent('End of the rail');
    expect(within(zoomed).queryByRole('button', { name: /^Next step/ })).toBeNull();
  });

  it('keeps a "N done" row unfolded across a zoom into one of its steps', async () => {
    state.rail = {
      ...state.rail!,
      steps: [row(firstPrep - 3, 'complete'), ...state.rail!.steps],
    };
    const board = await renderRail();
    fireEvent.click(within(board).getByRole('button', { name: '2 done', expanded: false }));
    fireEvent.click(
      within(board).getByRole('button', { name: new RegExp(`· ${catalog[firstPrep - 2].title} · Done$`) }),
    );
    await screen.findByRole('region', { name: 'Step detail' });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    const back = await screen.findByRole('region', { name: 'Rail overview' });
    expect(within(back).getByRole('button', { name: '2 done', expanded: true })).toBeInTheDocument();
  });

  it('zooms out on Escape, and opens the phase it returns to', async () => {
    const board = await renderRail();
    // Close Origination first: zooming out must open it again.
    fireEvent.click(within(board).getByRole('button', { name: MVP_DEAL_RAIL[1].name }));
    const zoomed = await zoomIntoCursor(board);
    expect(zoomed).toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: 'Escape' });
    const back = await screen.findByRole('region', { name: 'Rail overview' });
    expect(within(back).getByRole('button', { name: MVP_DEAL_RAIL[0].name })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('keeps the zoom when Escape belongs to a text field', async () => {
    const board = await renderRail();
    const zoomed = await zoomIntoCursor(board);
    const field = document.createElement('textarea');
    zoomed.appendChild(field);
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(screen.getByRole('region', { name: 'Step detail' })).toBeInTheDocument();
    field.remove();
  });

  it('zooms out on a ctrl-wheel or trackpad pinch out, and ignores a plain scroll', async () => {
    const board = await renderRail();
    const zoomed = await zoomIntoCursor(board);

    fireEvent.wheel(zoomed, { deltaY: 200 });
    expect(screen.getByRole('region', { name: 'Step detail' })).toBeInTheDocument();

    const pinch = new WheelEvent('wheel', { deltaY: 80, ctrlKey: true, bubbles: true, cancelable: true });
    act(() => {
      zoomed.dispatchEvent(pinch);
    });
    expect(pinch.defaultPrevented).toBe(true);
    expect(await screen.findByRole('region', { name: 'Rail overview' })).toBeInTheDocument();
  });

  it('zooms out on a two-finger pinch closing', async () => {
    const board = await renderRail();
    const zoomed = await zoomIntoCursor(board);
    const touch = (x: number) => ({ clientX: x, clientY: 0 });
    fireEvent.touchStart(zoomed, { touches: [touch(0), touch(200)] });
    fireEvent.touchMove(zoomed, { touches: [touch(15), touch(185)] });
    expect(screen.getByRole('region', { name: 'Step detail' })).toBeInTheDocument();
    fireEvent.touchMove(zoomed, { touches: [touch(80), touch(120)] });
    expect(await screen.findByRole('region', { name: 'Rail overview' })).toBeInTheDocument();
  });

  it('moves through the board by keyboard and jumps to a phase by its number', async () => {
    const board = await renderRail();
    const card = (index: number) =>
      within(board).getByRole('button', { name: new RegExp(`· ${catalog[index].title} · `) });
    const origination = within(board).getByRole('button', { name: MVP_DEAL_RAIL[0].name });
    const preparation = within(board).getByRole('button', { name: MVP_DEAL_RAIL[1].name });
    origination.focus();

    fireEvent.keyDown(origination, { key: 'ArrowDown' });
    expect(card(firstPrep - 2)).toHaveFocus();
    fireEvent.keyDown(card(firstPrep - 2), { key: 'ArrowDown' });
    expect(card(firstPrep - 1)).toHaveFocus();
    fireEvent.keyDown(card(firstPrep - 1), { key: 'ArrowUp' });
    fireEvent.keyDown(card(firstPrep - 2), { key: 'ArrowUp' });
    expect(origination).toHaveFocus();
    fireEvent.keyDown(origination, { key: 'ArrowRight' });
    expect(preparation).toHaveFocus();

    // Quick jump: "2" opens Preparation and lands on it.
    origination.focus();
    fireEvent.keyDown(origination, { key: '2' });
    expect(preparation).toHaveAttribute('aria-expanded', 'true');
    expect(preparation).toHaveFocus();
    expect(card(firstPrep)).toBeInTheDocument();

    // A card press zooms in.
    fireEvent.click(card(firstPrep));
    expect(await screen.findByRole('region', { name: 'Step detail' })).toHaveFocus();
  });

  it('gives each open column one tab stop: the current step, then the card last focused', async () => {
    const board = await renderRail();
    const card = (index: number) =>
      within(board).getByRole('button', { name: new RegExp(`· ${catalog[index].title} · `) });
    // Origination: the current step is the tab stop, the done step is reached by arrows.
    expect(card(firstPrep - 1)).toHaveAttribute('tabindex', '0');
    expect(card(firstPrep - 2)).toHaveAttribute('tabindex', '-1');

    card(firstPrep - 1).focus();
    fireEvent.keyDown(card(firstPrep - 1), { key: 'ArrowUp' });
    expect(card(firstPrep - 2)).toHaveFocus();
    expect(card(firstPrep - 2)).toHaveAttribute('tabindex', '0');
    expect(card(firstPrep - 1)).toHaveAttribute('tabindex', '-1');

    // Preparation: no current step there, so its first card is the stop.
    expect(card(firstPrep)).toHaveAttribute('tabindex', '0');
    expect(card(firstPrep + 1)).toHaveAttribute('tabindex', '-1');
  });

  it('takes focus into the zoomed step from "Open current step", even with its phase closed', async () => {
    const board = await renderRail();
    fireEvent.click(within(board).getByRole('button', { name: MVP_DEAL_RAIL[0].name }));
    fireEvent.click(screen.getByRole('button', { name: 'Open current step' }));
    const zoomed = await screen.findByRole('region', { name: 'Step detail' });
    await waitFor(() => expect(zoomed).toHaveFocus());
  });

  it('shows no step count in the zoom: the phase name and the neighbours place it', async () => {
    const board = await renderRail();
    const zoomed = await zoomIntoCursor(board);
    expect(within(zoomed).getByRole('button', { name: 'Zoom out to Origination' })).toBeInTheDocument();
    expect(within(zoomed).queryByText(/^Step \d+ of \d+/)).not.toBeInTheDocument();
  });

  it('lands a ?step= deep link with the step open over the board', async () => {
    state.search = new URLSearchParams(`step=${catalog[firstPrep].seq}`);
    const { DealRail } = await import('@/components/rail/DealRail');
    render(<DealRail />);
    await waitFor(() =>
      expect(screen.queryByText(/Loading (the deal rail|your deal list)/i)).not.toBeInTheDocument(),
    );
    // Synchronously on the first ready render: the step already open, the board behind it out of reach.
    expect(screen.queryByRole('region', { name: 'Rail overview' })).not.toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'Step detail' })).getByRole('heading', {
        level: 2,
        name: new RegExp(catalog[firstPrep].title),
      }),
    ).toBeInTheDocument();
  });
});

describe('RailBoard extension points (reorder, filters)', () => {
  it('hands a sortable item its ref, style and handle on the card, and follows stepsFor for order', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })) as unknown as typeof fetch;
    const { RailBoard } = await import('@/components/rail/RailBoard');
    const steps = [row(0, 'complete'), row(2, 'current'), row(3, 'pending')];
    const summaries = phaseSummaries(PHASES, steps, { currentStepId: 'uuid-3' });
    const itemRefs: (HTMLLIElement | null)[] = [];
    const listeners = { onPointerDown: vi.fn() };
    render(
      <RailBoard
        summaries={summaries}
        steps={steps}
        stateFor={(s) => (s.status === 'complete' ? 'done' : s.status === 'current' ? 'active' : 'todo')}
        run={{ receipts: {}, versions: {} }}
        deal={{ id: 'deal-1', codename: 'Project Cedar' } as never}
        expanded={new Set([1])}
        onTogglePhase={() => {}}
        onOpenStep={() => {}}
        // A preview reorder: the last step shown first.
        stepsFor={(summary) => [...summary.steps].reverse()}
        renderStack={(_summary, renderCard, shown) =>
          shown.map((step) =>
            renderCard(step, {
              ref: (el) => {
                itemRefs.push(el);
              },
              style: { transform: 'translateY(0px)' },
              handle: { attributes: { 'aria-roledescription': 'sortable' }, listeners },
            }),
          )
        }
      />,
    );
    const stack = screen.getByRole('list', { name: 'Origination steps' });
    const items = within(stack).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveStyle({ transform: 'translateY(0px)' });
    expect(itemRefs.filter(Boolean)).toHaveLength(3);
    const cards = within(stack).getAllByRole('button', { name: /^Step \d+ · / });
    expect(cards[0]).toHaveAccessibleName(`Step 03 · ${catalog[3].title} · To do`);
    expect(cards[0]).toHaveAttribute('aria-roledescription', 'sortable');
    fireEvent.pointerDown(cards[0]);
    expect(listeners.onPointerDown).toHaveBeenCalled();

    // Keyboard order follows what is shown, not rail order.
    cards[0].focus();
    fireEvent.keyDown(cards[0], { key: 'ArrowDown' });
    expect(cards[1]).toHaveFocus();
    expect(cards[1]).toHaveAccessibleName(new RegExp(`· ${catalog[2].title} · Current step$`));
  });
});

describe('Auto or Manual on a card', () => {
  it('reads a manual-checklist step as Manual, whatever its execution class', async () => {
    const { isAutoStep } = await import('@/components/rail/StepCard');
    const manual = catalog.find((s) => MANUAL_STEP_IDS.has(s.id) && !s.live && s.executionClass.startsWith('A'));
    expect(manual).toBeDefined();
    expect(isAutoStep(row(catalog.indexOf(manual!), 'pending'))).toBe(false);
    const agent = catalog.find((s) => !MANUAL_STEP_IDS.has(s.id) && s.executionClass.startsWith('A'));
    expect(agent).toBeDefined();
    expect(isAutoStep(row(catalog.indexOf(agent!), 'pending'))).toBe(true);
  });
});

describe('RailBoard add on the dashed track', () => {
  const stateFor = (s: ProjectRailStep) =>
    s.status === 'complete' ? 'done' : s.status === 'current' ? 'active' : 'todo';

  async function renderBoard(steps: ProjectRailStep[], onAddStepAfter?: (step: ProjectRailStep) => void) {
    global.fetch = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })) as unknown as typeof fetch;
    const { RailBoard } = await import('@/components/rail/RailBoard');
    render(
      <RailBoard
        summaries={phaseSummaries(PHASES, steps, { currentStepId: 'uuid-3' })}
        steps={steps}
        stateFor={stateFor}
        run={{ receipts: {}, versions: {} }}
        deal={{ id: 'deal-1', codename: 'Project Cedar' } as never}
        expanded={new Set([1])}
        onTogglePhase={() => {}}
        onOpenStep={() => {}}
        onAddStepAfter={onAddStepAfter}
      />,
    );
  }

  it('offers a plus between cards but not after the last, adding after the card above it', async () => {
    const onAdd = vi.fn();
    const steps = [row(2, 'current'), row(3, 'pending'), row(4, 'pending')];
    await renderBoard(steps, onAdd);
    const plusses = screen.getAllByRole('button', { name: /^Add a step after / });
    expect(plusses.map((b) => b.getAttribute('aria-label'))).toEqual([
      `Add a step after ${catalog[2].title}`,
      `Add a step after ${catalog[3].title}`,
    ]);
    // One tab stop per column: the card's plus follows the card's own stop.
    expect(plusses.map((b) => b.getAttribute('tabindex'))).toEqual(['0', '-1']);
    fireEvent.click(plusses[1]);
    expect(onAdd).toHaveBeenCalledWith(steps[1]);
  });

  it('under a closed "N done" row, adds after the run\'s last step', async () => {
    const onAdd = vi.fn();
    const steps = [row(0, 'complete'), row(1, 'complete'), row(2, 'current')];
    await renderBoard(steps, onAdd);
    fireEvent.click(screen.getByRole('button', { name: 'Add a step after the done steps' }));
    expect(onAdd).toHaveBeenCalledWith(steps[1]);
  });

  it('shows no plus when the parent offers no add', async () => {
    await renderBoard([row(2, 'current'), row(3, 'pending')]);
    expect(screen.queryByRole('button', { name: /^Add a step after / })).toBeNull();
  });
});

describe('RailBoard card keys with a sortable handle', () => {
  it('runs the handle\'s key listener first and moves focus only when it left the key alone', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })) as unknown as typeof fetch;
    const { RailBoard } = await import('@/components/rail/RailBoard');
    const steps = [row(0, 'complete'), row(2, 'current'), row(3, 'pending')];
    const summaries = phaseSummaries(PHASES, steps, { currentStepId: 'uuid-3' });
    let claim = true;
    const onKeyDown = vi.fn((e: { preventDefault: () => void }) => {
      if (claim) e.preventDefault();
    });
    render(
      <RailBoard
        summaries={summaries}
        steps={steps}
        stateFor={(s) => (s.status === 'complete' ? 'done' : s.status === 'current' ? 'active' : 'todo')}
        run={{ receipts: {}, versions: {} }}
        deal={{ id: 'deal-1', codename: 'Project Cedar' } as never}
        expanded={new Set([1])}
        onTogglePhase={() => {}}
        onOpenStep={() => {}}
        renderStack={(_summary, renderCard, shown) =>
          shown.map((step) =>
            renderCard(step, { handle: { attributes: {}, listeners: { onKeyDown } } }),
          )
        }
      />,
    );
    const stack = screen.getByRole('list', { name: 'Origination steps' });
    const cards = within(stack).getAllByRole('button', { name: /^Step \d+ · / });
    cards[0].focus();
    fireEvent.keyDown(cards[0], { key: 'ArrowDown' });
    expect(onKeyDown).toHaveBeenCalledTimes(1);
    expect(cards[0]).toHaveFocus();

    claim = false;
    fireEvent.keyDown(cards[0], { key: 'ArrowDown' });
    expect(onKeyDown).toHaveBeenCalledTimes(2);
    expect(cards[1]).toHaveFocus();
  });
});

describe('StepZoom main panel state', () => {
  it('reads the zoomed step through the board\'s stateFor, as the neighbours do', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })) as unknown as typeof fetch;
    const { StepZoom } = await import('@/components/rail/StepZoom');
    const steps = [row(0, 'complete'), row(1, 'pending'), row(2, 'pending')];
    render(
      <StepZoom
        steps={steps}
        phases={PHASES}
        viewIndex={1}
        run={{ receipts: {}, versions: {} }}
        dealId="deal-1"
        onComplete={() => {}}
        onSkip={() => {}}
        onJump={() => {}}
        onZoomOut={() => {}}
        // The board's overlay reads this pending step as before the entry.
        stateFor={(s) => (s.id === 'uuid-2' ? 'prior' : s.status === 'complete' ? 'done' : 'todo')}
      />,
    );
    const zoomed = screen.getByRole('region', { name: 'Step detail' });
    expect(
      await within(zoomed).findByText('Happened before this deal opened in Conductia. Reference only.'),
    ).toBeInTheDocument();
  });
});

describe('StepZoom "Draws on"', () => {
  it('lists what the step brief draws on with each step\'s status, a later one as "Later step", never as blocked', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })) as unknown as typeof fetch;
    const { StepZoom } = await import('@/components/rail/StepZoom');
    const at = (seq: number) => catalog.findIndex((s) => s.seq === seq);
    // Pitchbook Drafting (21) cites 15, 17, 19, 18 and League Table Submission (55).
    const steps = [row(at(15), 'complete'), row(at(18), 'pending'), row(at(19), 'pending'), row(at(21), 'current'), row(at(55), 'pending')];
    const onJump = vi.fn();
    render(
      <StepZoom
        steps={steps}
        phases={PHASES}
        viewIndex={3}
        run={{ receipts: {}, versions: {} }}
        dealId="deal-1"
        onComplete={() => {}}
        onSkip={() => {}}
        onJump={onJump}
        onZoomOut={() => {}}
        stateFor={(s) => (s.status === 'complete' ? 'done' : s.status === 'current' ? 'active' : 'todo')}
      />,
    );
    const zoomed = screen.getByRole('region', { name: 'Step detail' });
    const section = within(zoomed).getByRole('region', { name: 'Draws on' });
    expect(within(section).getByText('From the step brief')).toBeInTheDocument();
    const titleOf = (seq: number) => catalog.find((s) => s.seq === seq)!.title;
    expect(within(section).getByRole('button', { name: `${titleOf(15)} · Done` })).toBeInTheDocument();
    expect(within(section).getByRole('button', { name: `${titleOf(55)} · Later step` })).toBeInTheDocument();
    // Not on this deal's rail: named from the catalog, not a link.
    expect(within(section).getByText(titleOf(17))).toBeInTheDocument();
    expect(within(section).getByText('Not on this rail')).toBeInTheDocument();
    expect(zoomed.textContent).not.toMatch(/Blocked|Waiting on/i);

    fireEvent.click(within(section).getByRole('button', { name: `${titleOf(15)} · Done` }));
    expect(onJump).toHaveBeenCalledWith(0);
  });
});
