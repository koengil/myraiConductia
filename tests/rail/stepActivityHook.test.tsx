import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

import { useStepActivity } from '@/lib/rail/stepActivity';

/* The activity hook reports a failed read, and keeps the last good read on a poll failure. */

const EVENTS = [
  { ts: '2026-10-20T10:00:00Z', action: 'step_work', detail: { stepId: 'p2-s30' }, actor: { display_name: 'Alex Chen' } },
];

function respond(status: number) {
  return { ok: status < 400, status, json: async () => (status < 400 ? { events: EVENTS } : { error: 'boom' }) } as Response;
}

afterEach(() => vi.unstubAllGlobals());

describe('useStepActivity', () => {
  it('reports failed when the first read answers 500', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(500)));
    const { result } = renderHook(() => useStepActivity('D-1', true));
    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(result.current.byStep.size).toBe(0);
  });

  it('reports failed when the request rejects', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('offline'))));
    const { result } = renderHook(() => useStepActivity('D-1', true));
    await waitFor(() => expect(result.current.failed).toBe(true));
  });

  it('keeps the last good read on a poll failure and does not report failed', async () => {
    const fetchMock = vi.fn(async () => respond(200));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useStepActivity('D-1', true));
    await waitFor(() => expect(result.current.byStep.get('p2-s30')?.actorName).toBe('Alex Chen'));
    fetchMock.mockImplementation(async () => respond(500));
    act(() => result.current.refresh());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(result.current.failed).toBe(false);
    expect(result.current.byStep.get('p2-s30')?.actorName).toBe('Alex Chen');
  });

  it('is off (not failed) on the fixture path', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useStepActivity('D-1', false));
    expect(result.current.failed).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
