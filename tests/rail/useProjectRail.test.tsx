import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';

import { abortAllReads } from '@/lib/api/inflightRead';
import { MVP_DEAL_RAIL, orderedSteps } from '@/lib/rail/dealRail';
import { useProjectRail, type ProjectRail } from '@/lib/rail/projectRail';

const mocks = vi.hoisted(() => ({
  flags: new Set<string>(['project_rail_model']),
  deals: [] as { id: string }[],
  cursorStepId: '',
}));

vi.mock('@/lib/flags/FlagsContext', () => ({
  useFlag: (key: string) => mocks.flags.has(key),
}));

vi.mock('@/lib/deals/useDeals', () => ({
  useDeals: () => ({ deals: mocks.deals }),
  useDealListSource: () => ({ apiEnabled: true, fixtureFallback: false }),
  resolveActiveDeal: () => null,
  pendingDealForCode: (id: string) => ({ id, cursorStepId: mocks.cursorStepId }),
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ projectId: 'deal-1' }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/projects/deal-1',
  useSearchParams: () => new URLSearchParams(),
}));

afterEach(() => {
  // The in-flight coordinator is module state shared by every test here.
  // Unmount first: a still-mounted hook would re-join a fresh read on the
  // generation bump, and the next test would join that.
  cleanup();
  abortAllReads();
});

function serverRail(currentStepId: string): ProjectRail {
  return { currentStepId, canEditStructure: false, canSaveTemplate: false, phases: [], steps: [] };
}

describe('useProjectRail with the server model', () => {
  let railResponses: Array<(response: Response) => void>;

  beforeEach(() => {
    mocks.flags = new Set(['project_rail_model']);
    mocks.deals = [];
    railResponses = [];
    global.fetch = vi.fn((input: RequestInfo | URL) => {
      if (String(input).includes('/rail')) {
        return new Promise<Response>((resolve) => {
          railResponses.push(resolve);
        });
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        json: async () => ({ error: 'Not found' }),
      } as Response);
    }) as unknown as typeof fetch;
  });

  function respondWithRail(index: number, rail: ProjectRail) {
    railResponses[index]({ ok: true, json: async () => rail } as Response);
  }

  it('is loading until the first rail read resolves', async () => {
    const { result } = renderHook(() => useProjectRail('deal-1'));

    expect(result.current.status).toBe('loading');
    expect(result.current.rail).toBeNull();

    await waitFor(() => expect(railResponses).toHaveLength(1));
    await act(async () => respondWithRail(0, serverRail('step-1')));

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.rail?.currentStepId).toBe('step-1');
  });

  it('returns to loading on refresh until the refetched rail arrives', async () => {
    const { result } = renderHook(() => useProjectRail('deal-1'));
    await waitFor(() => expect(railResponses).toHaveLength(1));
    await act(async () => respondWithRail(0, serverRail('step-1')));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    act(() => result.current.refresh());

    expect(result.current.status).toBe('loading');
    expect(result.current.rail).toBeNull();

    await waitFor(() => expect(railResponses).toHaveLength(2));
    await act(async () => respondWithRail(1, serverRail('step-2')));

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.rail?.currentStepId).toBe('step-2');
  });

  it('two mounted instances share one /rail read (#162)', async () => {
    const { result } = renderHook(() => [useProjectRail('deal-1'), useProjectRail('deal-1')] as const);

    await waitFor(() => expect(railResponses).toHaveLength(1));
    await act(async () => respondWithRail(0, serverRail('step-1')));

    await waitFor(() => expect(result.current[0].status).toBe('ready'));
    expect(result.current[1].status).toBe('ready');
    expect(result.current[1].rail?.currentStepId).toBe('step-1');
    expect(railResponses).toHaveLength(1);
  });

  it('refresh() from one instance issues one new request that both instances see', async () => {
    const { result } = renderHook(() => [useProjectRail('deal-1'), useProjectRail('deal-1')] as const);
    await waitFor(() => expect(railResponses).toHaveLength(1));
    await act(async () => respondWithRail(0, serverRail('step-1')));
    await waitFor(() => expect(result.current[1].status).toBe('ready'));

    act(() => result.current[0].refresh());

    expect(result.current[0].status).toBe('loading');
    expect(result.current[1].status).toBe('loading');
    await waitFor(() => expect(railResponses).toHaveLength(2));
    await act(async () => respondWithRail(1, serverRail('step-2')));

    await waitFor(() => expect(result.current[1].rail?.currentStepId).toBe('step-2'));
    expect(result.current[0].rail?.currentStepId).toBe('step-2');
    expect(railResponses).toHaveLength(2);
  });

  it('reads the rail with cache no-store, like /me (#162)', async () => {
    renderHook(() => useProjectRail('deal-1'));
    await waitFor(() => expect(railResponses).toHaveLength(1));

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/v1/deals/deal-1/rail',
      expect.objectContaining({ credentials: 'include', cache: 'no-store' }),
    );
  });

  it('reports an error when the rail read fails', async () => {
    const { result } = renderHook(() => useProjectRail('deal-1'));
    await waitFor(() => expect(railResponses).toHaveLength(1));

    await act(async () =>
      railResponses[0]({ ok: false, status: 500, json: async () => ({}) } as Response),
    );

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.rail).toBeNull();
  });
});

describe('useProjectRail skip without the server model', () => {
  const cursorStep = orderedSteps(MVP_DEAL_RAIL).find((step) => !step.gate0)!;
  let stepRecords: unknown[];
  let patchResponse: { ok: boolean; status: number; body: unknown };

  beforeEach(() => {
    mocks.flags = new Set(['gate0_api_create']);
    mocks.deals = [{ id: 'deal-1' }];
    mocks.cursorStepId = cursorStep.id;
    stepRecords = [];
    patchResponse = { ok: true, status: 200, body: {} };
    global.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/step-records')) {
        return Promise.resolve({ ok: true, json: async () => ({ records: stepRecords }) } as Response);
      }
      if (init?.method === 'PATCH') {
        return Promise.resolve({
          ok: patchResponse.ok,
          status: patchResponse.status,
          json: async () => patchResponse.body,
        } as Response);
      }
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) } as Response);
    }) as unknown as typeof fetch;
  });

  function patchCalls() {
    return (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'PATCH',
    );
  }

  it('logs the skip on the deal record for a real deal, then advances the rail', async () => {
    const { result } = renderHook(() => useProjectRail('deal-1'));
    const steps = result.current.rail!.steps;
    const current = steps.find((step) => step.stepId === cursorStep.id)!;

    let outcome: Awaited<ReturnType<typeof result.current.skipStep>> = {};
    await act(async () => {
      outcome = await result.current.skipStep(steps, current, {
        approverId: 'user-2',
        approverName: 'Avery Lindqvist',
        reason: 'Handled off platform',
      });
    });

    const [[url, init]] = patchCalls();
    expect(url).toBe(`/api/v1/deals/deal-1/steps/${cursorStep.id}`);
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      // The id only: the server resolves the name and role (#312).
      skip: { approverId: 'user-2', reason: 'Handled off platform' },
    });
    expect(outcome.statusOverrides?.[current.id]).toBe('skipped');
  });

  it('reads no step records unless the caller asks for them', async () => {
    const { result } = renderHook(() => useProjectRail('deal-1'));

    await act(async () => {});
    expect(result.current.stepRecords).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('shows the skip the platform holds after a reload', async () => {
    stepRecords = [
      {
        stepId: cursorStep.id,
        seq: cursorStep.seq,
        status: 'skipped',
        assignedTo: null,
        assignedToName: null,
        completedBy: 'user-1',
        completedByName: 'Storm Duncan',
        completedAt: '2026-09-10T12:00:00Z',
        completionNote: 'Handled off platform',
        skip: {
          approver: 'Avery Lindqvist',
          approverRole: '',
          reason: 'Handled off platform',
          at: '2026-09-10T12:00:00Z',
        },
      },
    ];

    const { result } = renderHook(() => useProjectRail('deal-1', { withStepRecords: true }));

    await waitFor(() => expect(result.current.stepRecords).toHaveLength(1));
    // #162: the step-records read bypasses Chromium's HTTP cache lock, like /me.
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/v1/deals/deal-1/step-records',
      expect.objectContaining({ credentials: 'include', cache: 'no-store' }),
    );
    const skipped = result.current.rail!.steps.find((step) => step.stepId === cursorStep.id)!;
    expect(skipped.status).toBe('skipped');
    expect(skipped.skip).toMatchObject({
      approver: 'Avery Lindqvist',
      reason: 'Handled off platform',
    });
  });

  it('refuses the skip when the platform does not record it', async () => {
    patchResponse = { ok: false, status: 403, body: { error: 'Not permitted to skip this step' } };
    const { result } = renderHook(() => useProjectRail('deal-1'));
    const steps = result.current.rail!.steps;
    const current = steps.find((step) => step.stepId === cursorStep.id)!;

    await expect(
      result.current.skipStep(steps, current, {
        approverId: 'user-2',
        approverName: 'Avery Lindqvist',
        reason: 'Handled off platform',
      }),
    ).rejects.toThrow('Not permitted to skip this step');
  });

  it('keeps a fixture deal in memory without calling the platform', async () => {
    mocks.deals = [];
    const { result } = renderHook(() => useProjectRail('deal-1'));
    const steps = result.current.rail!.steps;
    const current = steps.find((step) => step.stepId === cursorStep.id)!;

    let outcome: Awaited<ReturnType<typeof result.current.skipStep>> = {};
    await act(async () => {
      outcome = await result.current.skipStep(steps, current, {
        approverId: 'user-2',
        approverName: 'Avery Lindqvist',
        reason: 'Handled off platform',
      });
    });

    expect(global.fetch).not.toHaveBeenCalled();
    expect(outcome.skipRecord?.skip.approver).toBe('Avery Lindqvist');
  });
});
