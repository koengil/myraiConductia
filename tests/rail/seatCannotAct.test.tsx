import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { RelationshipPathingPanel } from '@/components/rail/RelationshipPathingPanel';
import { ManualStepPanel } from '@/components/rail/ManualStepPanel';
import { FlagsProvider } from '@/lib/flags/FlagsContext';
import { FLAG_REGISTRY } from '@/lib/flags/keys';
import type { FlagMap } from '@/lib/flags/resolveFlags';

/*
 * A seat that cannot complete is told so, plainly, and every disabled
 * Complete names its reason in visible text through aria-describedby.
 */

vi.mock('@/lib/leads/useDealTargetCompany', () => ({
  useDealTargetCompany: () => ({ status: 'ready', companyId: 'c1', companyName: 'Atlassian' }),
}));
vi.mock('@/lib/audit/store', () => ({ logAudit: vi.fn() }));
vi.mock('next/navigation', () => ({ useParams: () => ({ projectId: 'atlas-2026' }) }));

const SEAT = "Your seat can't complete or skip this step.";

const flags = {
  ...Object.fromEntries(Object.keys(FLAG_REGISTRY).map((k) => [k, false])),
  gate0_api_create: true,
} as FlagMap;

const json = (status: number, body: unknown) =>
  ({ ok: status < 400, status, json: async () => body }) as Response;

function describedText(el: HTMLElement): string {
  const ids = (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
  expect(ids.length).toBeGreaterThan(0);
  return ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('RelationshipPathingPanel', () => {
  function stubPathing(patchStatus: number) {
    const paths: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url.endsWith('/relationships')) return json(200, { relationships: [{ id: 'r1', person_name: 'Jane Doe', relationship_type: 'prior client', strength: 'High', source: 'HubSpot', confidence: 'High' }] });
        if (url.endsWith('/stakeholders')) return json(200, { stakeholders: [{ id: 's1', name: 'Scott Farquhar', role_in_decision: 'decision-maker', motivation: 'legacy', stance: 'Supporter' }] });
        if (url.endsWith('/paths') && method === 'GET') return json(200, { paths });
        if (url.endsWith('/paths') && method === 'POST') {
          const body = JSON.parse(String(init?.body)) as { approve?: boolean };
          return json(201, { path: { id: 'p1', stakeholder_id: 's1', relationship_id: 'r1', path_type: 'warm', approved: Boolean(body.approve), approved_by: null, approved_on: null } });
        }
        if (method === 'PATCH') return json(patchStatus, { error: 'Forbidden' });
        if (url.includes('/steps/')) return json(200, { step: { work: {} } });
        return json(404, {});
      }),
    );
  }

  it('maps a 403 on completion to the seat line, never "The paths are saved"', async () => {
    stubPathing(403);
    const onApproved = vi.fn();
    render(
      <FlagsProvider value={flags}>
        <RelationshipPathingPanel dealId="project-summit" onApproved={onApproved} />
      </FlagsProvider>,
    );
    await screen.findByText('Scott Farquhar');
    fireEvent.change(screen.getByLabelText('Warm path'), { target: { value: 'r1' } });
    const approve = screen.getByRole('button', { name: 'Approve paths' });
    await waitFor(() => expect(approve).toBeEnabled());
    fireEvent.click(approve);
    expect(await screen.findByText(SEAT)).toBeInTheDocument();
    expect(screen.queryByText(/The paths are saved/)).not.toBeInTheDocument();
    expect(onApproved).not.toHaveBeenCalled();
    // Refused for this seat: no retry is offered, and the disabled button
    // points at the visible alert.
    const button = screen.getByRole('button', { name: /Complete step|Approve paths/ });
    await waitFor(() => expect(button).toBeDisabled());
    expect(describedText(button)).toBe(SEAT);
    expect(document.getElementById(button.getAttribute('aria-describedby') ?? '')).toHaveAttribute('role', 'alert');
  });

  it('an Observer seat sees approve disabled with the visible reason', async () => {
    stubPathing(200);
    render(
      <FlagsProvider value={flags}>
        <RelationshipPathingPanel dealId="project-summit" seatBlocked />
      </FlagsProvider>,
    );
    await screen.findByText('Scott Farquhar');
    const approve = screen.getByRole('button', { name: 'Approve paths' });
    expect(approve).toBeDisabled();
    expect(describedText(approve)).toBe(SEAT);
  });

  it('a later step names the reason: complete the current step first', async () => {
    stubPathing(200);
    render(
      <FlagsProvider value={flags}>
        <RelationshipPathingPanel dealId="project-summit" canApprove={false} />
      </FlagsProvider>,
    );
    await screen.findByText('Scott Farquhar');
    const approve = screen.getByRole('button', { name: 'Approve paths' });
    expect(approve).toBeDisabled();
    expect(describedText(approve)).toBe('Complete the current step first.');
  });
});

describe('ManualStepPanel', () => {
  function stubStep(
    status: string,
    canComplete: boolean,
    patchStatus = 200,
    { canEditWork = true, assignedTo = null as string | null, assignedToName = null as string | null } = {},
  ) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
        init?.method === 'PATCH'
          ? json(patchStatus, { error: 'Forbidden for this deal' })
          : json(200, {
              step: { stepId: 'p1-s11', status, assignedTo, assignedToName, work: { recommendation: 'Pursue' } },
              currentStepId: 'p1-s11',
              members: [],
              permissions: { isMd: false, canAssign: false, canComplete, canEditWork },
            }),
      ),
    );
  }

  // S6R4-03: the disabled checklist names its reason, like Save progress.
  it("a checklist the seat can't edit points at the save reason", async () => {
    stubStep('current', false, 200, { canEditWork: false, assignedTo: 'u-alex', assignedToName: 'Alex Chen' });
    render(
      <FlagsProvider value={flags}>
        <ManualStepPanel dealId="atlas-2026" stepId="p1-s11" />
      </FlagsProvider>,
    );
    const checklist = await screen.findByRole('group', { name: 'Manual checklist' });
    expect(checklist).toBeDisabled();
    const save = screen.getByRole('button', { name: 'Save progress' });
    expect(describedText(checklist)).toBe(describedText(save));
    expect(describedText(checklist)).toMatch(/^Assigned to Alex Chen\./);
  });

  it('a done checklist points at the visible done line', async () => {
    stubStep('complete', false, 200, { canEditWork: true });
    render(
      <FlagsProvider value={flags}>
        <ManualStepPanel dealId="atlas-2026" stepId="p1-s11" />
      </FlagsProvider>,
    );
    const checklist = await screen.findByRole('group', { name: 'Manual checklist' });
    expect(checklist).toBeDisabled();
    expect(describedText(checklist)).toBe('Complete on the deal record.');
    expect(screen.getByText('Complete on the deal record.')).toBeVisible();
  });

  it('an editable checklist carries no reason', async () => {
    stubStep('current', true);
    render(
      <FlagsProvider value={flags}>
        <ManualStepPanel dealId="atlas-2026" stepId="p1-s11" />
      </FlagsProvider>,
    );
    const checklist = await screen.findByRole('group', { name: 'Manual checklist' });
    expect(checklist).toBeEnabled();
    expect(checklist).not.toHaveAttribute('aria-describedby');
  });

  it('a disabled Mark step complete on a later step says to complete the current step first', async () => {
    stubStep('pending', false);
    render(
      <FlagsProvider value={flags}>
        <ManualStepPanel dealId="atlas-2026" stepId="p1-s11" />
      </FlagsProvider>,
    );
    const button = await screen.findByRole('button', { name: 'Mark step complete' });
    expect(button).toBeDisabled();
    expect(describedText(button)).toBe('Complete the current step first.');
  });

  it('on the current step with no right to complete, it names the seat', async () => {
    stubStep('current', false);
    render(
      <FlagsProvider value={flags}>
        <ManualStepPanel dealId="atlas-2026" stepId="p1-s11" />
      </FlagsProvider>,
    );
    const button = await screen.findByRole('button', { name: 'Mark step complete' });
    expect(describedText(button)).toBe(SEAT);
  });

  it('maps a 403 on completion to the seat line, not the server text', async () => {
    stubStep('current', true, 403);
    render(
      <FlagsProvider value={flags}>
        <ManualStepPanel dealId="atlas-2026" stepId="p1-s11" />
      </FlagsProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Mark step complete' }));
    expect(await screen.findByText(SEAT)).toBeInTheDocument();
    expect(screen.queryByText('Forbidden for this deal')).not.toBeInTheDocument();
  });
});
