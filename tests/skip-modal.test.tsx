import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { SkipModal } from '@/components/rail/SkipModal';
import type { ProjectRailStep } from '@/lib/rail/projectRail';

const useSkipApproversMock = vi.fn();
const useCurrentUserMock = vi.fn();

vi.mock('@/lib/rail/useSkipApprovers', () => ({
  useSkipApprovers: (args: unknown) => useSkipApproversMock(args),
}));
vi.mock('@/lib/auth/useCurrentUser', () => ({
  useCurrentUser: () => useCurrentUserMock(),
}));
vi.mock('@/lib/audit/store', () => ({
  logAudit: vi.fn(),
}));

const step: ProjectRailStep = {
  id: 'uuid-8',
  stepId: 'p2-s8',
  origin: 'catalog',
  phaseIndex: 2,
  displayOrder: 8,
  seq: 8,
  status: 'current',
  definition: { title: 'Relationship Pathing', description: 'd' },
  anchorStepId: null,
  removedAt: null,
  removedBy: null,
  skip: null,
};

beforeEach(() => {
  useCurrentUserMock.mockReturnValue({
    state: {
      status: 'ready',
      data: { user: { id: 'u-md' } },
    },
  });
  useSkipApproversMock.mockReturnValue({
    status: 'ready',
    members: [
      { id: 'u-md', name: 'Rob Admin', role: 'Managing Director' },
      { id: 'u-legal', name: 'Priya Mehta', role: 'Legal Counsel' },
    ],
  });
});

describe('SkipModal approver list', () => {
  it('numbers the step in its heading by step position, not display order', () => {
    render(
      <SkipModal
        step={step}
        stepNumber={3}
        dealId="PALET-2026-497"
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(
      screen.getByRole('heading', { name: 'Skip 03 · Relationship Pathing' }),
    ).toBeInTheDocument();
  });

  it('shows a spinner while the roster is loading', () => {
    useSkipApproversMock.mockReturnValue({
      status: 'loading',
      members: [],
    });
    render(
      <SkipModal
        step={step}
        stepNumber={8}
        dealId="PALET-2026-497"
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('Loading approvers…')).toBeInTheDocument();
    expect(screen.queryByText('No eligible approver on this deal.')).not.toBeInTheDocument();
  });

  it('reads its roster for this deal and step, live only when asked', () => {
    const props = { step, stepNumber: 8, dealId: 'PALET-2026-497', onConfirm: vi.fn(), onClose: vi.fn() };
    const { unmount } = render(<SkipModal {...props} live />);
    expect(useSkipApproversMock).toHaveBeenLastCalledWith({
      dealId: 'PALET-2026-497',
      stepKey: 'p2-s8',
      live: true,
    });
    unmount();
    render(<SkipModal {...props} />);
    expect(useSkipApproversMock).toHaveBeenLastCalledWith({
      dealId: 'PALET-2026-497',
      stepKey: 'p2-s8',
      live: false,
    });
  });

  it('names the roster failure and the empty roster', () => {
    const props = { step, stepNumber: 8, dealId: 'PALET-2026-497', onConfirm: vi.fn(), onClose: vi.fn() };
    useSkipApproversMock.mockReturnValue({ status: 'error', members: [] });
    const { unmount } = render(<SkipModal {...props} live />);
    expect(screen.getByText('Could not load approvers. Try again shortly.')).toBeInTheDocument();
    unmount();
    useSkipApproversMock.mockReturnValue({ status: 'ready', members: [] });
    render(<SkipModal {...props} live />);
    expect(screen.getByText('No eligible approver on this deal.')).toBeInTheDocument();
  });

  it('lists the approvers as "{name} · {role}", the shape the e2e skip splits on', () => {
    render(
      <SkipModal
        step={step}
        stepNumber={8}
        dealId="PALET-2026-497"
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole('option', { name: 'Rob Admin · Managing Director' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Priya Mehta · Legal Counsel' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /James Watt/i })).not.toBeInTheDocument();
    // e2e/steps/skipStepAtCursor.ts reads the approver name as label.split(' · ')[0].
    expect(screen.getAllByRole('option').map((o) => o.textContent?.split(' · ')[0])).toEqual([
      'Rob Admin',
      'Priya Mehta',
    ]);
  });

  it('defaults to the signed-in user when they are on the roster', () => {
    render(
      <SkipModal
        step={step}
        stepNumber={8}
        dealId="PALET-2026-497"
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole('combobox')).toHaveValue('u-md');
  });

  it('requires a reason before confirming', () => {
    const onConfirm = vi.fn();
    render(
      <SkipModal
        step={step}
        stepNumber={8}
        dealId="PALET-2026-497"
        onConfirm={onConfirm}
        onClose={vi.fn()}
      />,
    );

    const confirm = screen.getByRole('button', { name: 'Skip step' });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'Not applicable for this mandate.' },
    });
    expect(confirm).toBeEnabled();
  });

  it('requires an approver before confirming, blocking submission with an empty roster', () => {
    useSkipApproversMock.mockReturnValue({
      status: 'ready',
      members: [],
    });
    const onConfirm = vi.fn();
    render(
      <SkipModal
        step={step}
        stepNumber={8}
        dealId="PALET-2026-497"
        onConfirm={onConfirm}
        onClose={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'Not applicable for this mandate.' },
    });
    expect(screen.getByRole('button', { name: 'Skip step' })).toBeDisabled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('delegates the chosen approver, name and reason to onConfirm, then closes', async () => {
    const onConfirm = vi.fn(async () => {});
    render(
      <SkipModal
        step={step}
        stepNumber={8}
        dealId="PALET-2026-497"
        onConfirm={onConfirm}
        onClose={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'Not applicable for this mandate.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Skip step' }));

    await waitFor(() =>
      expect(onConfirm).toHaveBeenCalledWith({
        approverId: 'u-md',
        approverName: 'Rob Admin',
        reason: 'Not applicable for this mandate.',
      }),
    );
  });

  it('keeps the modal open and shows the error when onConfirm rejects', async () => {
    const onConfirm = vi.fn(async () => {
      throw new Error('A completed step cannot be skipped');
    });
    render(
      <SkipModal
        step={step}
        stepNumber={8}
        dealId="PALET-2026-497"
        onConfirm={onConfirm}
        onClose={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'Not applicable for this mandate.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Skip step' }));

    await waitFor(() =>
      expect(screen.getByText('A completed step cannot be skipped')).toBeInTheDocument(),
    );
    expect(screen.getByRole('dialog', { name: 'Skip Relationship Pathing' })).toBeInTheDocument();
  });

  it('ignores a scrim click so a typed reason is not lost; Escape still closes', () => {
    const onClose = vi.fn();
    render(
      <SkipModal step={step} stepNumber={8} dealId="PALET-2026-497" onConfirm={vi.fn()} onClose={onClose} />,
    );
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Covered by the prior mandate.' } });
    const dialog = screen.getByRole('dialog', { name: 'Skip Relationship Pathing' });
    fireEvent.click(dialog.parentElement as HTMLElement);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
