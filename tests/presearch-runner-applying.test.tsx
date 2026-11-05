/**
 * #249: a completed run whose memo is not yet applied reports `applying` (or a
 * retrying failure), and the runner keeps polling it, but only for
 * APPLY_TIMEOUT_MS. After that it stops and offers Retry applying.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { latestPresearch, pollPresearch, startPresearch } = vi.hoisted(() => ({
  latestPresearch: vi.fn(),
  pollPresearch: vi.fn(),
  startPresearch: vi.fn(),
}));

vi.mock('@/lib/ignatious/client', () => ({
  latestPresearch,
  startPresearch,
  pollPresearch,
  answerPresearch: vi.fn(),
  cancelPresearch: vi.fn(),
}));

import { APPLY_TIMEOUT_MS, PresearchRunner } from '@/components/leads/PresearchRunner';

const applying = { executionId: 'exec-1', status: 'completed', applied: null, applying: true };

async function startApplyingRun() {
  render(<PresearchRunner companyId="c1" companyName="Atlassian" />);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Run presearch' }));
  });
}

describe('PresearchRunner applying poll cap (#249)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    latestPresearch.mockReset().mockResolvedValue({ latest: null, pending: null });
    startPresearch.mockResolvedValue({ executionId: 'exec-1' });
    pollPresearch.mockReset().mockResolvedValue(applying);
  });
  afterEach(() => vi.useRealTimers());

  it('keeps polling a completed run while its memo is still applying', async () => {
    await startApplyingRun();
    await act(() => vi.advanceTimersByTimeAsync(APPLY_TIMEOUT_MS - 10_000));
    expect(pollPresearch.mock.calls.length).toBeGreaterThan(40);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('stops polling and says so after the apply deadline', async () => {
    await startApplyingRun();
    await act(() => vi.advanceTimersByTimeAsync(APPLY_TIMEOUT_MS + 5_000));
    expect(screen.getByRole('alert').textContent).toContain(
      'The research finished but is not applied to the lead yet.',
    );
    const calls = pollPresearch.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(pollPresearch.mock.calls.length).toBe(calls);
  });

  it('polls the stalled run again on Retry applying', async () => {
    await startApplyingRun();
    await act(() => vi.advanceTimersByTimeAsync(APPLY_TIMEOUT_MS + 5_000));
    const calls = pollPresearch.mock.calls.length;
    pollPresearch.mockResolvedValue({ ...applying, applying: false, applied: { peopleAdded: 2, alreadyApplied: false } });
    fireEvent.click(screen.getByRole('button', { name: 'Retry applying' }));
    await act(() => vi.advanceTimersByTimeAsync(2_500));
    expect(pollPresearch).toHaveBeenLastCalledWith('c1', 'exec-1');
    expect(pollPresearch.mock.calls.length).toBe(calls + 1);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Added 2 people from the memo.')).toBeTruthy();
  });

  it('keeps polling a failed apply that will be retried', async () => {
    pollPresearch.mockResolvedValue({ ...applying, applying: false, applyFailed: 'retrying' });
    await startApplyingRun();
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(pollPresearch.mock.calls.length).toBeGreaterThan(10);
  });

  it('stops polling and says so when the apply gave up', async () => {
    pollPresearch.mockResolvedValue({ ...applying, applying: false, applyFailed: 'terminal' });
    await startApplyingRun();
    const calls = pollPresearch.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(pollPresearch.mock.calls.length).toBe(calls);
    expect(screen.getByRole('alert').textContent).toContain('Applying stopped after repeated failures.');
  });

  it('clears the stall when the run is started again', async () => {
    await startApplyingRun();
    await act(() => vi.advanceTimersByTimeAsync(APPLY_TIMEOUT_MS + 5_000));
    fireEvent.click(screen.getByRole('button', { name: 'Run again' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('resumes polling a completed run that was never applied', async () => {
    latestPresearch.mockResolvedValue({ latest: null, pending: { execution_id: 'exec-9' } });
    pollPresearch.mockResolvedValue({ ...applying, executionId: 'exec-9' });
    render(<PresearchRunner companyId="c1" companyName="Atlassian" />);
    // Let the mount's latest read and resume poll commit before the clock runs.
    await act(async () => {});
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(pollPresearch).toHaveBeenCalledWith('c1', 'exec-9');
    expect(pollPresearch.mock.calls.length).toBeGreaterThan(1);
  });

  it('refreshes the memo and people when the first reload poll applies the run', async () => {
    latestPresearch.mockResolvedValueOnce({ latest: { memo_md: 'Old memo' }, pending: { execution_id: 'exec-9' } })
      .mockResolvedValue({ latest: { memo_md: 'Fresh memo' }, pending: null });
    pollPresearch.mockResolvedValue({ executionId: 'exec-9', status: 'completed', applied: { peopleAdded: 2, alreadyApplied: false } });
    const onApplied = vi.fn();
    render(<PresearchRunner companyId="c1" companyName="Atlassian" onApplied={onApplied} />);
    await act(async () => {});
    expect(screen.getByText('Added 2 people from the memo.')).toBeTruthy();
    expect(screen.getByText('Fresh memo')).toBeTruthy();
    expect(onApplied).toHaveBeenCalledOnce();
  });

  it('keeps the pending execution and retries after a failed reload poll', async () => {
    latestPresearch.mockResolvedValueOnce({ latest: null, pending: { execution_id: 'exec-9' } })
      .mockResolvedValue({ latest: { memo_md: 'Recovered memo' }, pending: null });
    pollPresearch.mockRejectedValueOnce(new Error('Network unavailable'))
      .mockResolvedValue({ executionId: 'exec-9', status: 'completed', applied: { peopleAdded: 0, alreadyApplied: false } });
    render(<PresearchRunner companyId="c1" companyName="Atlassian" />);
    await act(async () => {});
    expect(screen.getByRole('alert')).toHaveTextContent('Network unavailable');
    await act(() => vi.advanceTimersByTimeAsync(2_500));
    expect(screen.getByText('Recovered memo')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('restarts the apply deadline when applying clears in between', async () => {
    await startApplyingRun();
    await act(() => vi.advanceTimersByTimeAsync(APPLY_TIMEOUT_MS - 10_000));
    // One poll where the apply is not pending (a live claim released) resets the clock.
    pollPresearch.mockResolvedValueOnce({ ...applying, applying: false, status: 'running' });
    await act(() => vi.advanceTimersByTimeAsync(2_500));
    await act(() => vi.advanceTimersByTimeAsync(APPLY_TIMEOUT_MS - 10_000));
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('waits past the stale-claim window so a takeover can recover', async () => {
    const began = Date.now();
    pollPresearch.mockImplementation(async () => Date.now() - began < 122_500
      ? applying : { ...applying, applying: false, applied: { peopleAdded: 1, alreadyApplied: false } });
    await startApplyingRun();
    await act(() => vi.advanceTimersByTimeAsync(120_000));
    expect(screen.queryByRole('alert')).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(2500));
    expect(screen.getByText('Added 1 person from the memo.')).toBeTruthy();
  });

  it('stops repeated reload poll failures and permits an explicit retry', async () => {
    latestPresearch.mockResolvedValue({ latest: null, pending: { execution_id: 'exec-9' } });
    pollPresearch.mockRejectedValue(new Error('Network unavailable'));
    render(<PresearchRunner companyId="c1" companyName="Atlassian" />);
    await act(async () => {});
    await act(() => vi.advanceTimersByTimeAsync(APPLY_TIMEOUT_MS + 5000));
    const calls = pollPresearch.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(pollPresearch.mock.calls.length).toBe(calls);
    pollPresearch.mockResolvedValue({ ...applying, executionId: 'exec-9', applying: false, applied: { peopleAdded: 0, alreadyApplied: false } });
    fireEvent.click(screen.getByRole('button', { name: 'Retry checking status' }));
    await act(() => vi.advanceTimersByTimeAsync(2500));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Saved the presearch memo on this lead.')).toBeTruthy();
  });

  it('does not claim research finished when polling a running execution loses its connection', async () => {
    pollPresearch.mockResolvedValue({ executionId: 'exec-1', status: 'running' });
    await startApplyingRun();
    pollPresearch.mockRejectedValue(new Error('Network unavailable'));
    await act(() => vi.advanceTimersByTimeAsync(35_000));
    expect(screen.getByText('Unable to check the research status. The run may still be in progress.')).toBeTruthy();
    expect(screen.queryByText('The research finished but is not applied to the lead yet.')).toBeNull();
    const calls = pollPresearch.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(pollPresearch.mock.calls.length).toBe(calls);
    pollPresearch.mockResolvedValue({ executionId: 'exec-1', status: 'running' });
    fireEvent.click(screen.getByRole('button', { name: 'Retry checking status' }));
    await act(() => vi.advanceTimersByTimeAsync(2500));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('reports people who were skipped when the memo was applied', async () => {
    pollPresearch.mockResolvedValue({ ...applying, applying: false,
      applied: { peopleAdded: 2, peopleSkipped: 1, alreadyApplied: false } });
    await startApplyingRun();
    expect(screen.getByText(/Added 2 people from the memo.*1 person could not be added/)).toBeTruthy();
    expect(screen.getByText(/Review the memo and add them manually/)).toBeTruthy();
  });

});
