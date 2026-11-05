import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { ManualStepPanel } from '@/components/rail/ManualStepPanel';
import { FlagsProvider } from '@/lib/flags/FlagsContext';
import { FLAG_REGISTRY } from '@/lib/flags/keys';
import type { FlagMap } from '@/lib/flags/resolveFlags';

/* What the manual step panel names and says (S6 round 1). */

vi.mock('@/lib/audit/store', () => ({ logAudit: vi.fn() }));
vi.mock('next/navigation', () => ({ useParams: () => ({ projectId: 'atlas-2026' }) }));

const STEP_ID = 'p1-s11';

const flags = {
  ...Object.fromEntries(Object.keys(FLAG_REGISTRY).map((k) => [k, false])),
  gate0_api_create: true,
} as FlagMap;

const json = (status: number, body: unknown) =>
  ({ ok: status < 400, status, json: async () => body }) as Response;

function stubStep(
  permissions: { canComplete: boolean; canEditWork: boolean },
  status = 'current',
  owner: { assignedTo: string; assignedToName: string } | null = null,
) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      json(200, {
        step: { stepId: STEP_ID, status, assignedTo: null, assignedToName: null, ...owner, work: {} },
        currentStepId: STEP_ID,
        members: [],
        permissions: { isMd: false, canAssign: false, ...permissions },
      }),
    ),
  );
}

function renderPanel(stepTitle?: string) {
  return render(
    <FlagsProvider value={flags}>
      <ManualStepPanel dealId="atlas-2026" stepId={STEP_ID} stepTitle={stepTitle} />
    </FlagsProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ManualStepPanel labels', () => {
  it('puts the step slug in no accessible name (S6-08)', async () => {
    stubStep({ canComplete: true, canEditWork: true });
    const { container } = renderPanel();
    await screen.findByRole('button', { name: 'Save progress' });
    for (const el of container.querySelectorAll('[aria-label]')) {
      expect(el.getAttribute('aria-label')).not.toContain(STEP_ID);
    }
    // The work area is a plain container; the step view's section names it.
    expect((container.firstElementChild as HTMLElement).hasAttribute('aria-label')).toBe(false);
  });

  it('a disabled Save progress points at its visible reason (S6-23)', async () => {
    stubStep({ canComplete: false, canEditWork: false });
    renderPanel('Pursue / Pass Decision');
    const save = await screen.findByRole('button', { name: 'Save progress' });
    expect(save).toBeDisabled();
    const reason = document.getElementById(save.getAttribute('aria-describedby') ?? '');
    expect(reason).toHaveTextContent("Your seat can't save progress on this step.");
    expect(reason).toBeVisible();
  });

  it('an enabled Save progress carries no reason (S6-23)', async () => {
    stubStep({ canComplete: true, canEditWork: true });
    renderPanel('Pursue / Pass Decision');
    const save = await screen.findByRole('button', { name: 'Save progress' });
    expect(save).toBeEnabled();
    expect(save).not.toHaveAttribute('aria-describedby');
    expect(screen.queryByText("Your seat can't save progress on this step.")).not.toBeInTheDocument();
  });

  it('on a colleague\'s step, the Save progress reason names the owner (S6-23)', async () => {
    stubStep({ canComplete: false, canEditWork: false }, 'current', {
      assignedTo: 'u-alex',
      assignedToName: 'Alex Chen',
    });
    renderPanel('Pursue / Pass Decision');
    const save = await screen.findByRole('button', { name: 'Save progress' });
    expect(save).toBeDisabled();
    expect(document.getElementById(save.getAttribute('aria-describedby') ?? '')).toHaveTextContent(
      'Assigned to Alex Chen. Only they, the MD or a firm administrator can save progress.',
    );
    expect(screen.queryByText("Your seat can't save progress on this step.")).not.toBeInTheDocument();
  });
});
