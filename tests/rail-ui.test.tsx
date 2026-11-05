import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  render,
  screen,
  within,
  fireEvent,
  cleanup,
  waitFor,
} from '@testing-library/react';
import * as React from 'react';

import { DealRail } from '../src/components/rail/DealRail';
import { SessionProvider } from '../src/lib/session/store';
import { StepCard } from '../src/components/rail/StepCard';
import { StepContract } from '../src/components/rail/StepContract';
import { MVP_DEAL_RAIL, orderedSteps, totalSteps } from '../src/lib/rail/dealRail';
import type { FixtureDeal } from '../src/lib/rail/deals';
import type { ProjectRailStep } from '../src/lib/rail/projectRail';
import { skipApproverLabel } from '../src/lib/rail/skipApproverLabel';
import { stepCompletedBy } from '../src/lib/rail/stepRecords';
import { readAudit } from '../src/lib/audit/store';
import { OPEN_DRAFT_BUTTON } from './helpers/draftButton';

/*
 * Rail UI: the board (phases left to right, each opening into its steps), the
 * zoomed-in step, the logged skip flow, and the receipt grammar.
 *
 * Renders the DealRail surface against the seeded Atlassian sandbox deal
 * (cursor on the live Teaser step, seq 36). The surface renders the MVP
 * (execution) rail (WS9): New Business Development — the phase-1 origination
 * steps — is cut, so 61 MVP steps show (60 census execution + notify); the Teaser cursor
 * lands at MVP index 32. Domain census invariants (the full 65) live in
 * deal-rail.test.ts; THIS suite verifies the surface renders the MVP subset and
 * that the run/skip records land where the MD can see them.
 */

const MVP_TOTAL = totalSteps(MVP_DEAL_RAIL);

// next/navigation mock (same shape the golden path uses), extended with the
// search-params surface ?step= deep links read.
const replaceSpy = vi.fn();
let search = '';
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: replaceSpy,
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  useParams: () => ({ projectId: 'project-summit' }),
  usePathname: () => '/projects/project-summit/rail',
  useSearchParams: () => new URLSearchParams(search),
}));

function renderRail() {
  return render(
    <SessionProvider>
      <DealRail />
    </SessionProvider>,
  );
}

async function waitForRailReady() {
  await waitFor(() =>
    expect(screen.queryByText(/Loading (the deal rail|your deal list)/i)).not.toBeInTheDocument(),
  );
}

/** Open a closed phase on the board so its step cards render. */
async function openPhase(name: string) {
  const toggle = await screen.findByRole('button', { name });
  if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle);
}

beforeEach(() => {
  window.localStorage.clear();
  replaceSpy.mockClear();
  search = '';
});

afterEach(() => {
  cleanup();
});

describe('Board: census render', () => {
  it('renders 5 phase cards, every MVP step once opened, and one progress line', async () => {
    renderRail();
    await waitForRailReady();

    // Every phase header still renders — the MVP rail keeps all 5 phases (phase
    // 1 collapses to its persistent mandate-formation steps).
    for (const phase of MVP_DEAL_RAIL) {
      expect(
        await screen.findByRole('heading', { name: phase.name }),
      ).toBeInTheDocument();
    }

    // Every phase opens by default; the done run above the cursor stays folded.
    for (const phase of MVP_DEAL_RAIL) {
      expect(screen.getByRole('button', { name: phase.name })).toHaveAttribute(
        'aria-expanded',
        'true',
      );
    }
    for (const fold of screen.getAllByRole('button', { name: /^\d+ done$/, expanded: false })) {
      fireEvent.click(fold);
    }

    // Only the MVP steps render — New Business Development is cut.
    const stations = screen.getAllByRole('button', {
      name: /^Step \d+ · /,
    });
    expect(stations).toHaveLength(MVP_TOTAL);

    // The seeded deal sits on the live Teaser station: MVP index 18 (display 19).
    expect(screen.getByTestId('rail-progress-line')).toHaveTextContent(
      'Preparation · 10 of 13 steps done',
    );
    expect(
      screen.getByRole('button', {
        name: 'Step 32 · Teaser · Current step',
      }),
    ).toHaveAttribute('aria-current', 'step');
  });

  it('zooms into the step on a card click', async () => {
    renderRail();
    await waitForRailReady();
    await openPhase(MVP_DEAL_RAIL[0].name);

    fireEvent.click(
      await screen.findByRole('button', {
        name: /^Step 02 · Conflicts Checklist/,
      }),
    );

    expect(replaceSpy).not.toHaveBeenCalled();

    const focus = await screen.findByLabelText('Step detail');
    expect(
      within(focus).getByRole('heading', { level: 2, name: 'Conflicts Checklist' }),
    ).toBeInTheDocument();
    // The step name is the hero; its place on the rail is the secondary line.
    expect(
      within(focus).getByText((_, el) => el?.tagName === 'P' && el.textContent === 'Step 02 · Origination'),
    ).toBeInTheDocument();
    expect(within(focus).getByLabelText('What was done')).toBeInTheDocument();
    expect(within(focus).getByText('Complete')).toBeInTheDocument();
    expect(
      within(focus).getByText(/The firm is allowed to run a sell-side mandate/),
    ).toBeInTheDocument();
    expect(within(focus).getByText('Approved by')).toBeInTheDocument();
    expect(within(focus).getByText('Avery Lindqvist')).toBeInTheDocument();
    expect(within(focus).queryByRole('button', { name: OPEN_DRAFT_BUTTON })).toBeNull();
    expect(within(focus).queryByRole('button', { name: /Mark complete|Move to the next step/i })).toBeNull();
    expect(within(focus).queryByRole('button', { name: /Skip/i })).toBeNull();
    expect(screen.queryByRole('dialog', { name: /Conflicts/i })).toBeNull();
  });

  it('opens the codename step as complete with creator and creation date', async () => {
    renderRail();
    await waitForRailReady();
    await openPhase(MVP_DEAL_RAIL[0].name);

    fireEvent.click(
      await screen.findByRole('button', {
        name: /^Step 01 · Codename · Done/,
      }),
    );

    const focus = await screen.findByLabelText('Step detail');
    expect(within(focus).getByText('Complete')).toBeInTheDocument();
    expect(
      within(focus).getByText(/The deal was opened under the code name Project Summit/),
    ).toBeInTheDocument();
    expect(within(focus).getByText('Created by')).toBeInTheDocument();
    expect(within(focus).getByText('Storm Duncan')).toBeInTheDocument();
    expect(within(focus).getByText('Created on')).toBeInTheDocument();
    // A record day reads like the rest of the app, never ISO.
    expect(within(focus).getByText('May 1, 2026')).toBeInTheDocument();
    expect(within(focus).getByLabelText('What was done').textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(within(focus).queryByRole('button', { name: OPEN_DRAFT_BUTTON })).toBeNull();
    expect(within(focus).queryByRole('button', { name: /Skip/i })).toBeNull();
  });

  it('opens the notify step as complete with recipients and notice text', async () => {
    renderRail();
    await waitForRailReady();
    await openPhase(MVP_DEAL_RAIL[0].name);

    fireEvent.click(
      await screen.findByRole('button', {
        name: /^Step 03 · Notify Compliance · Done/,
      }),
    );

    const focus = await screen.findByLabelText('Step detail');
    expect(within(focus).getByText('Complete')).toBeInTheDocument();
    expect(
      within(focus).getByText(/Compliance was notified that a new mandate opened/),
    ).toBeInTheDocument();
    expect(within(focus).getByText('Sent to')).toBeInTheDocument();
    expect(within(focus).getByText('Pat Rivera')).toBeInTheDocument();
    expect(within(focus).getByText('Sent on')).toBeInTheDocument();
    expect(within(focus).queryByLabelText('Notification recipients')).toBeNull();
    expect(within(focus).queryByLabelText('Notice sent')).toBeNull();
    expect(within(focus).queryByRole('button', { name: /Mark complete|Move to the next step/i })).toBeNull();
  });
});

describe('Advance-only button (handoff E28)', () => {
  it('labels the bare cursor move honestly on a skill-backed current step, never "Mark complete"', async () => {
    renderRail();
    await waitForRailReady();
    fireEvent.click(screen.getByRole('button', { name: 'Open current step' }));
    const focus = await screen.findByLabelText('Step detail');
    expect(within(focus).getByRole('heading', { level: 2, name: 'Teaser' })).toBeInTheDocument();
    expect(within(focus).queryByRole('button', { name: /^Mark (step )?complete$/ })).toBeNull();
    const advance = within(focus).getByRole('button', { name: 'Move to the next step' });
    const noteId = advance.getAttribute('aria-describedby');
    expect(noteId).toBeTruthy();
    expect(document.getElementById(noteId as string)).toHaveTextContent(
      "This moves the deal's current step. It does not record this step as done.",
    );

    // The local audit row says what happened: a move, not a completion.
    fireEvent.click(advance);
    expect(readAudit().some((e) => e.action === 'Moved to the next step' && e.target === 'Teaser')).toBe(true);
    expect(readAudit().some((e) => e.action === 'Marked complete' && e.target === 'Teaser')).toBe(false);
  });
});

describe('Skip flow — logged approval', () => {
  // This suite renders DealRail with the project rail model flag off, so the
  // rail stays the catalogue fixture (railFromCatalog) with no deal_steps row
  // behind it. Skip must therefore apply the in-memory status override and
  // advance the cursor exactly as it did before this rail became server
  // truth for the flag-on path, and it must never POST a catalogue step id to
  // a route that expects a deal_steps UUID.
  it('skips the active step through the approver + reason modal without calling the skip route', async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({ error: 'Not found' }),
    })) as unknown as typeof fetch;
    renderRail();
    await waitForRailReady();

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Step 32 · Teaser · Current step',
      }),
    );
    const focus = await screen.findByLabelText('Step detail');
    fireEvent.click(within(focus).getByRole('button', { name: 'Skip…' }));

    const modal = await screen.findByRole('dialog', { name: 'Skip Teaser' });
    const confirm = within(modal).getByRole('button', { name: 'Skip step' });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(modal).getByRole('textbox'), {
      target: { value: 'Client supplied their own teaser.' },
    });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);

    fireEvent.click(await screen.findByRole('button', { name: 'Zoom out to Preparation' }));

    expect(
      await screen.findByRole('button', {
        name: 'Step 32 · Teaser · Skipped',
      }),
    ).toBeInTheDocument();

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Step 32 · Teaser · Skipped',
      }),
    );
    const skippedFocus = await screen.findByLabelText('Step detail');
    await waitFor(() =>
      expect(
        within(skippedFocus).getByText(
          /Skipped · approved by Storm Duncan · Client supplied their own teaser\. · routed onward/,
        ),
      ).toBeInTheDocument(),
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Zoom out to Preparation' }));
    expect(
      await screen.findByRole('button', {
        name: /^Step 33 · .+ · Current step$/,
      }),
    ).toBeInTheDocument();

    const calls = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some((call) => String(call[0]).includes('/skip'))).toBe(false);
  });
});

describe('Skip approver label for rail-model skips', () => {
  const TEASER = orderedSteps(MVP_DEAL_RAIL).find((step) => step.title === 'Teaser');
  if (!TEASER) throw new Error('Teaser step missing from the MVP rail');

  function skippedStep(approverVerified?: boolean): ProjectRailStep {
    return {
      id: 'deal-step-teaser',
      stepId: TEASER!.id,
      origin: 'catalog',
      phaseIndex: 2,
      displayOrder: 32,
      seq: TEASER!.seq,
      status: 'skipped',
      definition: null,
      anchorStepId: null,
      removedAt: null,
      removedBy: null,
      skip: {
        at: '2026-09-01T09:00:00.000Z',
        by: 'Storm Duncan',
        approver: 'Jordan Reyes',
        reason: 'Client supplied their own teaser',
        ...(approverVerified === undefined ? {} : { approverVerified }),
      },
      catalog: TEASER,
    };
  }

  function renderCard(step: ProjectRailStep) {
    const skip = step.skip ?? undefined;
    return render(
      <StepCard
        step={step}
        state="skipped"
        completedBy={stepCompletedBy({} as FixtureDeal, step.stepId, skip)}
      />,
    );
  }

  function renderFocus(step: ProjectRailStep) {
    return render(
      <SessionProvider>
        <StepContract
          step={TEASER!}
          projectStep={step}
          phase={MVP_DEAL_RAIL[1]}
          state="skipped"
          dealId="project-summit"
          receipts={[]}
          skip={step.skip ?? undefined}
          versions={[]}
          onComplete={() => undefined}
          onSkip={() => undefined}
          stepNumber={32}
        />
      </SessionProvider>,
    );
  }

  it('prefixes an unverified approver with "recorded as" on the card and in Focus', () => {
    const step = skippedStep(false);

    renderCard(step);
    expect(screen.getByText('Completed by: recorded as Jordan Reyes')).toBeInTheDocument();
    cleanup();

    renderFocus(step);
    expect(
      screen.getByText(
        'Skipped · approved by recorded as Jordan Reyes · Client supplied their own teaser · routed onward',
      ),
    ).toBeInTheDocument();
  });

  it('shows a verified approver without the prefix on the card and in Focus', () => {
    const step = skippedStep(true);

    renderCard(step);
    expect(screen.getByText('Completed by: Jordan Reyes')).toBeInTheDocument();
    cleanup();

    renderFocus(step);
    expect(
      screen.getByText(
        'Skipped · approved by Jordan Reyes · Client supplied their own teaser · routed onward',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/recorded as/)).toBeNull();
  });

  it('drops an empty approver from the card and Focus lines instead of leaving "approved by  ·"', () => {
    const step = skippedStep(false);
    const blank = { ...step, skip: { ...step.skip!, approver: '' } };

    renderCard(blank);
    expect(screen.getByText('Completed by: Client supplied their own teaser')).toBeInTheDocument();
    cleanup();

    renderFocus(blank);
    expect(
      screen.getByText('Skipped · Client supplied their own teaser · routed onward'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/approved by/)).toBeNull();
  });

  it('keeps an unmarked skip (local or step-record) without the prefix', () => {
    expect(skipApproverLabel({ approver: 'Jordan Reyes' })).toBe('Jordan Reyes');
    expect(skipApproverLabel({ approver: 'Jordan Reyes', approverVerified: true })).toBe(
      'Jordan Reyes',
    );
    expect(skipApproverLabel({ approver: 'Jordan Reyes', approverVerified: false })).toBe(
      'recorded as Jordan Reyes',
    );
    expect(skipApproverLabel({ approver: '', approverVerified: false })).toBe('');
  });

  it('uses the same label for the step completer line', () => {
    const deal = {} as FixtureDeal;
    expect(
      stepCompletedBy(deal, TEASER.id, { approver: 'Jordan Reyes', approverVerified: false }),
    ).toBe('recorded as Jordan Reyes');
    expect(stepCompletedBy(deal, TEASER.id, { approver: 'Jordan Reyes' })).toBe('Jordan Reyes');
  });
});

describe('Receipts — collapsed run grammar', () => {
  it('renders a persisted run as "Screened · 12s ›" on the step and expands to the checks', async () => {
    // No auth client in this suite: the single local actor owns the store.
    window.localStorage.setItem(
      'ib-rail-run:project-summit',
      JSON.stringify({
        uid: 'local',
        receipts: {
          'p1-s6': [
            {
              id: 'r-fixture',
              label: 'Screened',
              verdict: 'clear',
              checks: ['KYC ✓', 'FINRA ✓', 'MNPI ✓'],
              seconds: 12,
              tokens: 1240,
              at: '2026-07-07T10:00:00.000Z',
            },
          ],
        },
        versions: {},
      }),
    );

    renderRail();
    await waitForRailReady();
    await openPhase(MVP_DEAL_RAIL[0].name);

    const receipt = await screen.findByRole('button', {
      name: /Screened · 12s/,
    });
    expect(receipt).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(receipt);
    expect(receipt).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('KYC ✓')).toBeInTheDocument();
    expect(screen.getByText('Cleared')).toBeInTheDocument();
    expect(screen.queryByText('~1,240 tokens')).not.toBeInTheDocument();
  });
});

describe('Zoom: the current step and deep links', () => {
  it('zooms into the current step from the header, with its neighbours either side', async () => {
    renderRail();
    await waitForRailReady();
    expect(screen.queryByRole('button', { name: 'Full Array' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Focus' })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Open current step' }));

    const focus = await screen.findByRole('region', { name: 'Step detail' });
    expect(
      within(focus).getByRole('heading', { level: 2, name: 'Teaser' }),
    ).toBeInTheDocument();
    expect(
      within(focus).getByRole('button', { name: OPEN_DRAFT_BUTTON }),
    ).toBeInTheDocument();
    expect(within(focus).getByText('Teaser V1')).toBeInTheDocument();
    expect(within(focus).getByText('Teaser V2')).toBeInTheDocument();
    expect(within(focus).getByRole('navigation', { name: 'Previous step' })).toBeInTheDocument();
    expect(within(focus).getByRole('navigation', { name: 'Next step' })).toBeInTheDocument();
    // Header actions belong to the board, not the zoomed step.
    expect(screen.queryByRole('button', { name: 'Open current step' })).toBeNull();
  });

  it('lands zoomed in on a ?step= deep link and keeps the parameter, adopted in place (S6R4-04)', async () => {
    search = 'step=36&new=1';
    window.history.replaceState(null, '', '/projects/project-summit/rail?step=36&new=1');
    const push = vi.spyOn(window.history, 'pushState');
    try {
      renderRail();
      await waitForRailReady();

      const focus = await screen.findByRole('region', { name: 'Step detail' });
      expect(within(focus).getByRole('heading', { level: 2, name: 'Teaser' })).toBeInTheDocument();
      expect(
        within(focus).getByText((_, el) => el?.tagName === 'P' && el.textContent === 'Step 32 · Preparation'),
      ).toBeInTheDocument();
      await waitFor(() =>
        expect(window.history.state).toMatchObject({ conductiaRailZoom: { link: true } }),
      );
      expect(window.location.search).toBe('?step=36&new=1');
      expect(push).not.toHaveBeenCalled();
      expect(replaceSpy).not.toHaveBeenCalled();
    } finally {
      push.mockRestore();
      window.history.replaceState(null, '', '/');
    }
  });

  it.each(['999', '-1', '9abc'])(
    'says a ?step=%s that names no step is no longer on this rail, and drops the parameter',
    async (value) => {
      search = `step=${value}`;
      renderRail();
      await waitForRailReady();
      expect(await screen.findByText('That step is no longer on this rail.')).toBeInTheDocument();
      expect(screen.queryByRole('region', { name: 'Step detail' })).toBeNull();
      await waitFor(() =>
        expect(replaceSpy).toHaveBeenCalledWith('/projects/project-summit/rail', { scroll: false }),
      );
    },
  );

  it('zooms in on a later valid ?step= after an invalid one was consumed', async () => {
    search = 'step=999';
    const { rerender } = renderRail();
    await waitForRailReady();
    await screen.findByText('That step is no longer on this rail.');
    // The URL drops the parameter, then a later link names a real step.
    search = '';
    rerender(
      <SessionProvider>
        <DealRail />
      </SessionProvider>,
    );
    search = 'step=36';
    rerender(
      <SessionProvider>
        <DealRail />
      </SessionProvider>,
    );
    const focus = await screen.findByRole('region', { name: 'Step detail' });
    expect(within(focus).getByRole('heading', { level: 2, name: 'Teaser' })).toBeInTheDocument();
    // The board (and its note) leaves with the zoom's exit.
    await waitFor(() => expect(screen.queryByText('That step is no longer on this rail.')).toBeNull());
  });
});
