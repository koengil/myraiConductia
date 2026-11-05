import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AssignStepControls } from '@/components/rail/AssignStepControls';
import { ManualStepPanel } from '@/components/rail/ManualStepPanel';
import { FlagsProvider } from '@/lib/flags/FlagsContext';
import { FLAG_REGISTRY, type FlagKey } from '@/lib/flags/keys';
import type { FlagMap } from '@/lib/flags/resolveFlags';

vi.mock('next/navigation', () => ({
  useParams: () => ({ projectId: 'atlas-2026' }),
}));

vi.mock('@/lib/deals/useDeals', () => ({
  useActiveDeal: () => ({ codename: 'Project Solstice' }),
}));

const DEAL = 'atlas-2026';
const STEP = 'p1-s11';
const MEMBERS = [
  { id: 'user-storm', name: 'Storm Duncan', dealRole: 'md' },
  { id: 'user-alex', name: 'Alex Chen', dealRole: 'deal_team' },
];

function flags(): FlagMap {
  const off = Object.fromEntries(Object.keys(FLAG_REGISTRY).map((key) => [key, false])) as Record<
    FlagKey,
    boolean
  >;
  return { ...off, gate0_api_create: true };
}

const server = {
  assignedTo: null as string | null,
  canAssign: true,
  patches: [] as unknown[],
};

function stepBody() {
  const owner = MEMBERS.find((m) => m.id === server.assignedTo) ?? null;
  return {
    step: {
      stepId: STEP,
      status: 'current',
      assignedTo: server.assignedTo,
      assignedToName: owner?.name ?? null,
      work: {},
      updatedAt: '2026-10-22T10:00:00.000Z',
    },
    currentStepId: STEP,
    members: MEMBERS,
    permissions: { isMd: server.canAssign, canAssign: server.canAssign, canComplete: true, canEditWork: true },
  };
}

/**
 * The PATCH response exactly as the route builds it
 * (src/app/api/v1/deals/[dealId]/steps/[stepId]/route.ts): `{ currentStepId,
 * step }`, where serializeStep gets no assignee, so `assignedToName` is null
 * even when `assignedTo` is set, and there are no members or permissions.
 */
function patchResponseBody(updatedAt = '2026-10-22T11:00:00.000Z') {
  const { step, currentStepId } = stepBody();
  return { currentStepId, step: { ...step, assignedToName: null, updatedAt } };
}

beforeEach(() => {
  server.assignedTo = null;
  server.canAssign = true;
  server.patches = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/v1/me')) {
        return new Response(
          JSON.stringify({ user: { id: 'user-storm', email: 'storm@example.com' }, company: null, mandate: null }),
          { status: 200 },
        );
      }
      if (init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as { assignTo: string | null };
        server.patches.push(body);
        server.assignedTo = body.assignTo;
        return new Response(JSON.stringify(patchResponseBody()), { status: 200 });
      }
      return new Response(JSON.stringify(stepBody()), { status: 200 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function assignAlex() {
  fireEvent.click(await screen.findByRole('button', { name: 'Assign…' }));
  const dialog = await screen.findByRole('dialog', { name: 'Conflicts Checklist' });
  const alex = await within(dialog).findByRole('radio', { name: /^Alex Chen/ });
  // The role reads as a plain label, never the raw "deal_team".
  expect(alex.closest('label')).toHaveTextContent('Alex ChenDeal Team');
  expect(dialog).not.toHaveTextContent('deal_team');
  fireEvent.click(alex);
  expect(within(dialog).getByText('Alex Chen gets a notification that this step is theirs.')).toBeInTheDocument();
  // Choosing someone sends nothing; only the confirm does.
  expect(server.patches).toHaveLength(0);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Assign to Alex Chen' }));
  await waitFor(() => expect(server.patches).toEqual([{ assignTo: 'user-alex' }]));
}

describe('step detail assigns through the confirm dialog', () => {
  it('ManualStepPanel: the MD reads the owner, then Assign… names who is notified before the PATCH', async () => {
    render(
      <FlagsProvider value={flags()}>
        <ManualStepPanel dealId={DEAL} stepId={STEP} stepTitle="Conflicts Checklist" />
      </FlagsProvider>,
    );

    expect(await screen.findByText('Unassigned')).toBeInTheDocument();
    expect(screen.queryByLabelText('Assigned to')).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /Assigned to/ })).not.toBeInTheDocument();

    await assignAlex();
    expect(await screen.findByText('Assigned to Alex Chen')).toBeInTheDocument();
  });

  it('ManualStepPanel: someone who may not assign reads the name only', async () => {
    server.canAssign = false;
    server.assignedTo = 'user-alex';
    render(
      <FlagsProvider value={flags()}>
        <ManualStepPanel dealId={DEAL} stepId={STEP} stepTitle="Conflicts Checklist" />
      </FlagsProvider>,
    );

    expect(await screen.findByText('Assigned to Alex Chen')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Assign…' })).not.toBeInTheDocument();
  });

  it('ManualStepPanel: keeps what the banker typed when the owner changes', async () => {
    render(
      <FlagsProvider value={flags()}>
        <ManualStepPanel dealId={DEAL} stepId="p1-s10" stepTitle="Conflicts Checklist" />
      </FlagsProvider>,
    );
    const notes = await screen.findByLabelText('Meeting notes or transcript summary');
    fireEvent.change(notes, { target: { value: 'Unsaved notes' } });

    await assignAlex();
    expect(await screen.findByText('Assigned to Alex Chen')).toBeInTheDocument();
    expect(screen.getByLabelText('Meeting notes or transcript summary')).toHaveValue('Unsaved notes');
  });

  it('Relationship Pathing (AssignStepControls): the same dialog, no raw role, no one-tap select', async () => {
    render(
      <FlagsProvider value={flags()}>
        <AssignStepControls dealId={DEAL} stepId={STEP} stepTitle="Conflicts Checklist" />
      </FlagsProvider>,
    );

    expect(await screen.findByText('Unassigned')).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    await assignAlex();
    expect(await screen.findByText('Assigned to Alex Chen')).toBeInTheDocument();
  });
});

describe('a failed step read in step detail', () => {
  it('AssignStepControls says the owner could not be loaded, never Unassigned, and retries', async () => {
    const base = vi.mocked(global.fetch).getMockImplementation()!;
    let fail = true;
    vi.mocked(global.fetch).mockImplementation(async (input, init) => {
      if (fail && String(input).includes('/steps/') && (init?.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify({ error: 'boom' }), { status: 500 });
      }
      return base(input, init);
    });
    render(
      <FlagsProvider value={flags()}>
        <AssignStepControls dealId={DEAL} stepId={STEP} stepTitle="Conflicts Checklist" />
      </FlagsProvider>,
    );
    expect(await screen.findByText('Owner could not be loaded.')).toBeInTheDocument();
    expect(screen.queryByText('Unassigned')).not.toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Unassigned')).toBeInTheDocument();
    expect(screen.queryByText('Owner could not be loaded.')).not.toBeInTheDocument();
  });
});

describe('the row version after an assign', () => {
  it('the next Save progress sends the version the assign PATCH returned, keeping the typed checklist', async () => {
    const sent: Record<string, unknown>[] = [];
    vi.mocked(global.fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/v1/me')) {
        return new Response(JSON.stringify({ user: { id: 'user-storm', email: 'storm@example.com' }, company: null, mandate: null }), { status: 200 });
      }
      if (init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        sent.push(body);
        if ('assignTo' in body) {
          server.assignedTo = body.assignTo as string | null;
          return new Response(JSON.stringify(patchResponseBody()), { status: 200 });
        }
        return new Response(JSON.stringify(stepBody()), { status: 200 });
      }
      // Every GET still answers the old version T1 (a stale re-read).
      return new Response(JSON.stringify(stepBody()), { status: 200 });
    });
    render(
      <FlagsProvider value={flags()}>
        <ManualStepPanel dealId={DEAL} stepId="p1-s10" stepTitle="Conflicts Checklist" />
      </FlagsProvider>,
    );
    const notes = await screen.findByLabelText('Meeting notes or transcript summary');
    fireEvent.change(notes, { target: { value: 'Typed before the assign' } });

    fireEvent.click(await screen.findByRole('button', { name: 'Assign…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Conflicts Checklist' });
    fireEvent.click(await within(dialog).findByRole('radio', { name: /^Alex Chen/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Assign to Alex Chen' }));
    expect(await screen.findByText('Assigned to Alex Chen')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByLabelText('Meeting notes or transcript summary')).toHaveValue('Typed before the assign');

    fireEvent.click(screen.getByRole('button', { name: 'Save progress' }));
    await waitFor(() => expect(sent.some((b) => 'work' in b && !('complete' in b))).toBe(true));
    const save = sent.find((b) => 'work' in b && !('complete' in b))!;
    expect(save.expectedUpdatedAt).toBe('2026-10-22T11:00:00.000Z');
    expect(Object.values(save.work as Record<string, unknown>)).toContain('Typed before the assign');
  });
});

describe('the assign PATCH as the route returns it (post-merge e2e)', () => {
  it('names the new owner from the deal team when the PATCH step carries only the id', async () => {
    render(
      <FlagsProvider value={flags()}>
        <ManualStepPanel dealId={DEAL} stepId={STEP} stepTitle="Conflicts Checklist" />
      </FlagsProvider>,
    );
    expect(await screen.findByText('Unassigned')).toBeInTheDocument();
    await assignAlex();
    expect(await screen.findByText('Assigned to Alex Chen')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByText('Unassigned')).not.toBeInTheDocument();
  });

  it('re-reads the step when the PATCH names an owner the dialog does not know', async () => {
    const base = vi.mocked(global.fetch).getMockImplementation()!;
    vi.mocked(global.fetch).mockImplementation(async (input, init) => {
      if (init?.method === 'PATCH') {
        // The server saved someone the dialog's team read did not list.
        server.patches.push(JSON.parse(String(init.body)));
        server.assignedTo = 'user-alex';
        const body = patchResponseBody();
        return new Response(JSON.stringify({ ...body, step: { ...body.step, assignedTo: 'user-someone-else' } }), { status: 200 });
      }
      return base(input, init);
    });
    render(
      <FlagsProvider value={flags()}>
        <ManualStepPanel dealId={DEAL} stepId={STEP} stepTitle="Conflicts Checklist" />
      </FlagsProvider>,
    );
    await assignAlex();
    // Never "Unassigned" over an owner: the GET names who owns it.
    expect(await screen.findByText('Assigned to Alex Chen')).toBeInTheDocument();
  });
});
