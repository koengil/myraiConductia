import type { ReactElement } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MotionGlobalConfig } from 'framer-motion';

import { RailsSettings } from '@/components/settings/RailsSettings';
import { getLocalPref } from '@/lib/prefs/localPrefs';

import {
  PUBLISHED_STEP_ID,
  addedStep,
  baseRail,
  existingStep,
  flags,
  installFetch,
  publishedStep,
  railBox,
  renderRail,
  rerenderRail,
  secondExistingStep,
  waitForRailReady,
} from '../helpers/dealRailPublicationHarness';
import { waitForDraftLoaded } from '../helpers/skillBuilderDialogFixtures';

/*
 * Settings › Rails and the rail's edit prompt are one loop: "never" (from
 * "Don't ask again" or the switch) silences the prompt after a remove and an
 * add alike, and switching Settings back to ask brings it back on the next
 * edit, with no reload. The rail reads the choice at the moment of each edit.
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useParams: () => ({ projectId: 'deal-1' }),
  usePathname: () => '/projects/deal-1/rail',
  useSearchParams: () => new URLSearchParams(),
}));

const refreshSpy = vi.fn();
vi.mock('@/lib/rail/projectRail', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rail/projectRail')>();
  return {
    ...actual,
    useProjectRail: () => ({
      rail: railBox.rail,
      status: railBox.status,
      refresh: refreshSpy,
      skipStep: vi.fn(async () => ({})),
      stepRecords: [],
    }),
  };
});

// Overlay exits finish at once, so closes are awaited without real motion.
beforeAll(() => {
  MotionGlobalConfig.skipAnimations = true;
});
afterAll(() => {
  MotionGlobalConfig.skipAnimations = false;
});

beforeEach(() => {
  window.localStorage.clear();
  railBox.rail = baseRail([existingStep(), secondExistingStep(), addedStep()]);
  railBox.status = 'ready';
  refreshSpy.mockClear();
  installFetch();
});

afterEach(() => {
  cleanup();
});

const deletes = () =>
  (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
    ([, init]) => (init as RequestInit | undefined)?.method === 'DELETE',
  ).length;

/** Zooms into a step: Move to… and Remove live in its detail. */
async function openStep(stepTitle: string) {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`· ${stepTitle} · `) }));
  return screen.findByRole('region', { name: 'Step detail' });
}

async function cycleRail(nextRail: ReturnType<typeof baseRail>, rerender: (node: ReactElement) => void) {
  railBox.rail = null;
  railBox.status = 'loading';
  rerenderRail(flags(), rerender);
  await waitFor(() => expect(screen.getByText(/Loading the deal rail/i)).toBeInTheDocument());
  railBox.rail = nextRail;
  railBox.status = 'ready';
  rerenderRail(flags(), rerender);
}

it('never silences the prompt after a remove and an add; switching Settings back to ask brings it back on a move', async () => {
  window.localStorage.setItem('conductia.pref.railEditPrompt', 'never');
  const { rerender } = renderRail(flags());
  await waitForRailReady();

  // Remove: the step goes through the existing DELETE, and no prompt follows.
  const detail = await openStep('Added after launch');
  fireEvent.click(within(detail).getByRole('button', { name: 'Remove', exact: true } as never));
  fireEvent.click(within(detail).getByRole('button', { name: 'Remove step' }));
  await waitFor(() => expect(deletes()).toBe(1));
  await waitFor(() => expect(refreshSpy).toHaveBeenCalled());
  await act(async () => {});
  expect(screen.queryByRole('dialog', { name: /removed/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /^Zoom out to / }));
  await screen.findByRole('region', { name: 'Rail overview' });

  // Add: the new step lands on the board, highlighted, and no prompt follows.
  await cycleRail(baseRail([existingStep(), secondExistingStep()]), rerender);
  fireEvent.click(screen.getAllByRole('button', { name: 'Add new step' })[0]);
  await screen.findByRole('dialog');
  await waitForDraftLoaded();
  fireEvent.click(screen.getByRole('button', { name: 'Save skill and add step' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  await cycleRail(baseRail([existingStep(), secondExistingStep(), publishedStep()]), rerender);
  const added = await screen.findByTestId(`step-${PUBLISHED_STEP_ID}`);
  await waitFor(() => expect(added).toHaveAttribute('data-highlight', 'new'));
  await act(async () => {});
  expect(screen.queryByRole('dialog', { name: /Weekly filing summary added/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

  // Settings › Rails, rendered beside the rail, switched back to ask.
  render(<RailsSettings />);
  const toggle = await screen.findByRole('checkbox', { name: 'Ask before changing the rail' });
  await waitFor(() => expect(toggle).toBeEnabled());
  expect(toggle).not.toBeChecked();
  fireEvent.click(toggle);
  expect(toggle).toBeChecked();
  expect(getLocalPref('railEditPrompt')).toBe('ask');

  // Move: the prompt is back, with no reload of the rail.
  fireEvent.click(screen.getByRole('button', { name: 'Edit rail' }));
  const moving = await openStep('Diligence checklist');
  fireEvent.click(within(moving).getByRole('button', { name: 'Move to…' }));
  const move = await screen.findByRole('dialog', { name: 'Diligence checklist' });
  fireEvent.click(within(move).getAllByRole('radio').at(-1)!);
  fireEvent.click(within(move).getByRole('button', { name: 'Move step' }));
  expect(await screen.findByRole('dialog', { name: 'Diligence checklist moved' })).toBeInTheDocument();
});
