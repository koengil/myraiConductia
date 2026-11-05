import { describe, expect, it } from 'vitest';

import { benchSessionOf, benchSessionPatch } from '@/lib/api/v1/benchSession';

const EMPTY = {
  bench_conversation_id: null,
  bench_run_id: null,
  bench_run_status: null,
  bench_run_started_at: null,
};

const RUNNING = {
  bench_conversation_id: 'a5841918-7bfa-4e12-b1fd-e82bd44d55e6',
  bench_run_id: '951fce9e-c067-4e99-ad50-194374ba49da',
  bench_run_status: 'running',
  bench_run_started_at: '2026-09-03T10:00:00.000Z',
};

describe('bench session on a deal step', () => {
  it('reads back nothing when no run was recorded', () => {
    expect(benchSessionOf(EMPTY)).toBeNull();
  });

  it('reads back the identity a run recorded', () => {
    expect(benchSessionOf(RUNNING)).toEqual({
      conversationId: RUNNING.bench_conversation_id,
      runId: RUNNING.bench_run_id,
      status: 'running',
      startedAt: RUNNING.bench_run_started_at,
    });
  });

  it('clears every column when the runner is cleared', () => {
    expect(benchSessionPatch(null, RUNNING)).toEqual(EMPTY);
  });

  it('keeps the start time when a running run completes', () => {
    expect(benchSessionPatch({ status: 'complete' }, RUNNING)).toEqual({
      ...RUNNING,
      bench_run_status: 'complete',
    });
  });

  it('rejects a session with neither id', () => {
    expect(benchSessionPatch({ conversationId: null, runId: null }, EMPTY)).toEqual({
      error: 'benchSession needs a conversationId or a runId',
    });
  });

  it('rejects a status outside the schema enum', () => {
    const result = benchSessionPatch(
      { runId: 'r1', status: 'streaming' as unknown as 'running' },
      EMPTY,
    );
    expect(result).toEqual({ error: 'benchSession.status is not a known run status' });
  });
});
