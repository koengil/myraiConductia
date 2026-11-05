import { describe, expect, it, vi, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';

import { MdBriefingRunner } from '@/components/rail/MdBriefingRunner';
import {
  RUN_FAILED_MESSAGE,
  RUN_UNAVAILABLE_MESSAGE,
} from '@/lib/ignatious/failure';
import { SessionProvider } from '@/lib/session/store';

const LEAKY_SERVER_ERROR = 'Ignatious control plane unreachable: TypeError: fetch failed';

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function runStatus(over: Partial<{ status: string; error: { code: string; message: string } | null }> = {}) {
  return {
    executionId: 'exec-1',
    runId: 'run-1',
    agentName: 'md-briefing',
    status: 'running',
    outcome: null,
    startedAt: null,
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

function renderRunner() {
  return render(
    <SessionProvider>
      <MdBriefingRunner dealId="E2EHZ-2026-747" />
    </SessionProvider>,
  );
}

async function clickRun() {
  await act(async () => {
    screen.getByRole('button', { name: 'Draft the MD brief' }).click();
  });
}

describe('MdBriefingRunner failure state', () => {
  it('renders a terminal failure with a retry when the run is rejected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(503, { error: LEAKY_SERVER_ERROR })),
    );
    renderRunner();
    expect(screen.getByText('Conductia drafts the MD brief. You review it before you mark the step complete.')).toBeTruthy();
    await clickRun();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Run failed');
    expect(alert.textContent).toContain(RUN_UNAVAILABLE_MESSAGE);
    expect(screen.getByRole('button', { name: 'Retry run' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Draft the MD brief' })).toBeTruthy();
  });

  it('keeps server and infrastructure detail out of the failure copy', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(503, { error: LEAKY_SERVER_ERROR })),
    );
    const { container } = renderRunner();
    await clickRun();

    await screen.findByRole('alert');
    const rendered = container.textContent ?? '';
    for (const leak of ['localhost', '4111', 'IGNATIOUS_', 'fetch failed', 'TypeError', 'skill-bench']) {
      expect(rendered).not.toContain(leak);
    }
  });

  it('stops showing the run as in flight when polling is rejected', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = vi
      .fn()
      // The panel asks for the station's newest run when it mounts: none yet.
      .mockResolvedValueOnce(jsonResponse(404, { error: 'No run on this step' }))
      .mockResolvedValueOnce(jsonResponse(202, { executionId: 'exec-1', runId: 'run-1' }))
      .mockResolvedValueOnce(jsonResponse(200, runStatus()))
      .mockResolvedValue(jsonResponse(503, { error: LEAKY_SERVER_ERROR }));
    vi.stubGlobal('fetch', fetchMock);

    renderRunner();
    await clickRun();
    await waitFor(() => expect(screen.getByText(/Researching the company/i)).toBeTruthy());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2600);
    });

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.queryByText(/Researching the company/i)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel run' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry run' })).toBeTruthy();
  });

  it('reports a run the control plane finished as failed', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(404, { error: 'No run on this step' }))
      .mockResolvedValueOnce(jsonResponse(202, { executionId: 'exec-1', runId: 'run-1' }))
      .mockResolvedValueOnce(
        jsonResponse(
          200,
          runStatus({ status: 'failed', error: { code: 'upstream', message: LEAKY_SERVER_ERROR } }),
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const { container } = renderRunner();
    await clickRun();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(RUN_FAILED_MESSAGE);
    expect(container.textContent).not.toContain('fetch failed');
  });
});
