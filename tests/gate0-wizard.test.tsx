import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  cleanup,
  act,
} from '@testing-library/react';
import * as React from 'react';

import { Gate0Wizard } from '../src/components/wizard/Gate0Wizard';
import { SessionProvider } from '../src/lib/session/store';
import {
  firstStepAfterGate0,
  GATE0_ACTIONS,
} from '../src/lib/rail/dealRail';
import { getAllDeals } from '../src/lib/rail/deals';

/*
 * Gate 0 wizard (develop-design vision spec §4.3 + the conflicts gate).
 *
 * Five sub-steps: the ledger's four GATE0_ACTIONS plus the conflicts approval
 * attestation (Seq 6, "are we allowed to have a deal with this company?")
 * between code name and team, with the code-name step selecting an existing
 * lead and the entry point (default 04 · Relationship Pathing) last. The suite locks that mirror, the step progression (next/back), the
 * insight flow's mask validation on the code name, the attestation gate
 * (approver + date + confirmation required), the screened-notification receipt,
 * and the createDeal payload the gate writes (entryStepSeq + gate0Complete)
 * before landing on the rail.
 */

const pushSpy = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: pushSpy,
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/projects',
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(),
}));

beforeEach(() => {
  pushSpy.mockClear();
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
});

/** Render the wizard and flush the seam's getTeam microtask inside act. */
async function renderWizard(props: React.ComponentProps<typeof Gate0Wizard> = {}) {
  render(
    <SessionProvider>
      <Gate0Wizard {...props} />
    </SessionProvider>,
  );
  await act(async () => {});
}

async function fillCodenameStep(target = 'Canva', codename = 'Project Meridian') {
  // If a lead is already selected the typeahead collapses to a "Lead: … Change"
  // row; reopen the search first so a re-selection (e.g. after Back) works.
  const change = screen.queryByRole('button', { name: /change/i });
  if (change) fireEvent.click(change);
  fireEvent.change(screen.getByLabelText(/^lead$/i), {
    target: { value: target },
  });
  fireEvent.click(await screen.findByRole('option', { name: target }));
  fireEvent.change(screen.getByLabelText(/^code name$/i), {
    target: { value: codename },
  });
}

/** Fill the conflicts attestation sub-step (approver + confirmation; the date
 *  defaults to today). */
function fillConflictsStep(approver = 'Avery Lindqvist') {
  fireEvent.change(screen.getByLabelText(/approved by/i), {
    target: { value: approver },
  });
  fireEvent.click(screen.getByLabelText(/confirm the conflicts approval/i));
}

function clickNext() {
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
}

describe('Gate0Wizard', () => {
  it('renders the five Gate 0 sub-steps: the ledger actions plus the conflicts gate and the entry point', async () => {
    await renderWizard();

    // Plain, sentence-case names, one per ledger action.
    expect(GATE0_ACTIONS).toHaveLength(4);
    expect(screen.getByTitle('Create the code name')).toBeInTheDocument();
    expect(screen.getByTitle("Record the senior partner's conflicts approval")).toBeInTheDocument();
    expect(screen.getByTitle('Assign the deal team')).toBeInTheDocument();
    expect(screen.getByTitle('Notify Compliance and management')).toBeInTheDocument();
    expect(screen.getByTitle('Confirm where the deal enters the rail')).toBeInTheDocument();
    for (const raw of GATE0_ACTIONS) expect(screen.queryByTitle(raw)).toBeNull();

    expect(
      screen.getByRole('region', { name: 'Create the code name' }),
    ).toBeInTheDocument();
    // The stepper above already numbers the sub-steps; no "1 of 5" line.
    expect(screen.queryByText(/Gate 0 · 1 of 5/)).toBeNull();
  });

  it('gates the conflicts sub-step on approver + confirmation', async () => {
    await renderWizard();
    await fillCodenameStep();
    clickNext(); // → conflicts

    // Nothing recorded yet — the gate holds.
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();

    // Approver alone is not enough; the confirmation must be checked too.
    fireEvent.change(screen.getByLabelText(/approved by/i), {
      target: { value: 'Avery Lindqvist' },
    });
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();

    fireEvent.click(screen.getByLabelText(/confirm the conflicts approval/i));
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
  });

  it('rejects a future approval date at the gate (not just at create)', async () => {
    await renderWizard();
    await fillCodenameStep();
    clickNext(); // → conflicts
    fillConflictsStep();
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();

    fireEvent.change(screen.getByLabelText(/approved on/i), {
      target: { value: '2099-01-01' },
    });
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('voids the attestation confirmation when the target changes', async () => {
    await renderWizard();
    await fillCodenameStep();
    clickNext(); // → conflicts
    fillConflictsStep();
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();

    // Back, swap the target: the approval was answered for a DIFFERENT company,
    // so the confirmation must be re-affirmed (approver + date persist).
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await fillCodenameStep('Figma', 'Project Vertex');
    clickNext(); // → conflicts

    expect(screen.getByLabelText(/approved by/i)).toHaveValue('Avery Lindqvist');
    expect(
      screen.getByLabelText(/confirm the conflicts approval/i),
    ).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('validates the code name mask exactly like the insight flow', async () => {
    await renderWizard();

    await fillCodenameStep('Canva', 'Project Canva');
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    expect(screen.getByLabelText(/^code name$/i)).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(
      screen.getByText(/pick a suggestion below or rename it/i),
    ).toBeInTheDocument();

    // Deterministic suggestions always mask the target — typing a valid name clears
    // the violation.
    fireEvent.change(screen.getByLabelText(/^code name$/i), {
      target: { value: 'Project Meridian' },
    });
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
  });

  it('walks the five sub-steps (with back) and creates the deal with the Gate 0 payload', async () => {
    await renderWizard();

    // 1 · code name
    await fillCodenameStep();
    clickNext();

    // 2 · conflicts approval — the Seq 6 attestation gates everything after it.
    fillConflictsStep();
    clickNext();

    // 3 · team & permissions — fixture personas; the MD is locked on.
    const md = await screen.findByLabelText('Storm Duncan · MD');
    expect(md).toBeChecked();
    expect(md).toBeDisabled();
    const cfo = screen.getByLabelText('James Watt · CFO');
    expect(cfo).toBeChecked();
    fireEvent.click(cfo);
    expect(cfo).not.toBeChecked();

    // Back preserves the conflicts sub-step state.
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByLabelText(/approved by/i)).toHaveValue('Avery Lindqvist');
    clickNext();

    // 4 · notify compliance — an honest preview (no fabricated KYC/FINRA/MNPI
    // checkmarks, no "notified" before anything is sent).
    clickNext();
    expect(screen.getByText(/Will notify on create/i)).toBeInTheDocument();
    expect(screen.getByText('Pat Rivera')).toBeInTheDocument();
    expect(screen.getByText(/Pending create/i)).toBeInTheDocument();
    expect(screen.queryByText(/KYC ✓/)).not.toBeInTheDocument();
    clickNext();

    // 5 · entry point — defaults to the first post-intake step.
    expect(screen.getByRole('combobox', { name: 'Starting step' })).toHaveValue(
      String(firstStepAfterGate0()!.seq),
    );
    expect(screen.getByText('Opens at step 04 · Relationship Pathing.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Create the mandate' }));

    // COMPLIANCE: the deal lands at its CODE-NAME slug, never the target —
    // the URL must not name the masked seller ('Project Meridian' → project-meridian).
    expect(pushSpy).toHaveBeenCalledWith('/projects/project-meridian/rail?new=1');
    const postGate0 = firstStepAfterGate0()!;
    const deal = getAllDeals().find((d) => d.id === 'project-meridian');
    expect(deal).toBeDefined();
    expect(deal).toMatchObject({
      codename: 'Project Meridian',
      target: 'Canva',
      targetCompanyId: 'canva',
      entryStepSeq: postGate0.seq,
      gate0Complete: true,
      cursorStepId: postGate0.id,
      isNew: true,
      team: [
        { id: 'sd', role: 'MD' },
        { id: 'sr', role: 'M&A Advisor' },
      ],
    });
    expect(deal?.team?.some((m) => m.id === 'jw')).toBe(false);
  });

  it('opens the mandate after Gate 0 on the first post-intake rail step', async () => {
    await renderWizard();

    await fillCodenameStep('Figma', 'Project Vertex');
    clickNext();
    fillConflictsStep();
    clickNext(); // → team
    clickNext(); // → notify
    clickNext(); // → entry

    fireEvent.click(screen.getByRole('button', { name: 'Create the mandate' }));

    expect(pushSpy).toHaveBeenCalledWith('/projects/project-vertex/rail?new=1');
    const postGate0 = firstStepAfterGate0()!;
    const deal = getAllDeals().find((d) => d.id === 'project-vertex');
    expect(deal).toMatchObject({
      entryStepSeq: postGate0.seq,
      gate0Complete: true,
      cursorStepId: postGate0.id,
    });
  });

  it('opens the mandate at the step the MD chose', async () => {
    await renderWizard();

    await fillCodenameStep('Figma', 'Project Vertex');
    clickNext();
    fillConflictsStep();
    clickNext(); // → team
    clickNext(); // → notify
    clickNext(); // → entry

    fireEvent.change(screen.getByRole('combobox', { name: 'Starting step' }), {
      target: { value: '48' },
    });
    expect(
      screen.getByText(
        'Opens at step 44 · LOI Review. Earlier steps are labeled "Before this deal started" and stay reference only.',
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Create the mandate' }));

    expect(pushSpy).toHaveBeenCalledWith('/projects/project-vertex/rail?new=1');
    const deal = getAllDeals().find((d) => d.id === 'project-vertex');
    expect(deal).toMatchObject({
      entryStepSeq: 48,
      gate0Complete: true,
      cursorStepId: 'p4-s48',
    });
  });

  it('keeps Next disabled until a lead is selected', async () => {
    await renderWizard();

    // No lead selected yet — the gate must hold, even with a code name typed.
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();

    await fillCodenameStep();
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
  });

  it('offers Cancel on the first sub-step when the dialog provides it', async () => {
    const onCancel = vi.fn();
    await renderWizard({ onCancel });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
