import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';

import { MdBriefingRunner } from '@/components/rail/MdBriefingRunner';
import { SessionProvider } from '@/lib/session/store';

/*
 * Prod bug bash Finding 3 (Sep 7): a md-briefing run paused on its blocking
 * questions was lost as soon as the MD left step 05 — the run kept
 * running on Ignatious, only the panel forgot it. The panel now asks for the
 * newest run on the step when it mounts and resumes an active one.
 */

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

function runStatus(over: Record<string, unknown> = {}) {
  return {
    executionId: 'exec-paused',
    runId: 'run-1',
    agentName: 'md-briefing',
    status: 'running',
    outcome: null,
    startedAt: '2026-09-07T19:35:58Z',
    finishedAt: null,
    dryRun: false,
    pendingQuestions: [],
    artifacts: [],
    filings: [],
    costUsd: null,
    durationMs: null,
    error: null,
    ...over,
  };
}

/** fetch stub keyed on the query: the mount-time `latest=1` lookup vs. the poll. */
function stubFetch(latest: () => Response, poll: () => Response = () => jsonResponse(500, {})) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('latest=1')) return latest();
    return poll();
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderRunner() {
  return render(
    <SessionProvider>
      <MdBriefingRunner dealId="ZZTES-2026-653" />
    </SessionProvider>,
  );
}

describe('MdBriefingRunner — picks an active run back up on mount', () => {
  it('resumes a run paused on blocking questions without pressing Run', async () => {
    const paused = runStatus({
      pendingQuestions: [
        { questionId: 'real_company', text: 'Which company is this brief about?', options: null, blocking: true },
      ],
    });
    const fetchMock = stubFetch(() => jsonResponse(200, paused), () => jsonResponse(200, paused));
    renderRunner();

    await screen.findByText('Which company is this brief about?');
    expect(screen.queryByRole('button', { name: 'Draft the MD brief' })).toBeNull();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('latest=1');
  });

  it('opens on the run form when the step has no run yet (404)', async () => {
    const fetchMock = stubFetch(() => jsonResponse(404, { error: 'No run on this step' }));
    renderRunner();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // Let the lookup's promise chain settle before reading the form.
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Draft the MD brief' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not re-show a finished run', async () => {
    const fetchMock = stubFetch(() => jsonResponse(200, runStatus({ status: 'completed', outcome: 'ok' })));
    renderRunner();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // Let the lookup's promise chain settle before reading the form.
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Draft the MD brief' })).toBeTruthy();
  });

  it('stays on the run form when the lookup itself fails', async () => {
    const fetchMock = stubFetch(() => jsonResponse(503, { error: 'unreachable' }));
    renderRunner();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // Let the lookup's promise chain settle before reading the form.
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Draft the MD brief' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
