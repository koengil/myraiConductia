import { BENCH_RUN_STATUSES, BENCH_RUN_STATUS, type BenchRunStatus } from '@/lib/constants/dealSteps';

export type BenchSessionPatch = {
  conversationId?: string | null;
  runId?: string | null;
  status?: BenchRunStatus;
};

export type BenchSessionRow = {
  bench_conversation_id: string | null;
  bench_run_id: string | null;
  bench_run_status: string | null;
  bench_run_started_at: string | null;
};

export function benchSessionOf(step: BenchSessionRow) {
  if (!step.bench_conversation_id && !step.bench_run_id) return null;
  return {
    conversationId: step.bench_conversation_id,
    runId: step.bench_run_id,
    status: step.bench_run_status,
    startedAt: step.bench_run_started_at,
  };
}

export function benchSessionPatch(
  value: BenchSessionPatch | null,
  current: BenchSessionRow,
): Record<string, unknown> | { error: string } {
  if (value === null) {
    return {
      bench_conversation_id: null,
      bench_run_id: null,
      bench_run_status: null,
      bench_run_started_at: null,
    };
  }
  if (typeof value !== 'object') return { error: 'benchSession must be an object or null' };

  const conversationId =
    value.conversationId === undefined
      ? current.bench_conversation_id
      : typeof value.conversationId === 'string' && value.conversationId.trim()
        ? value.conversationId.trim()
        : null;
  const runId =
    value.runId === undefined
      ? current.bench_run_id
      : typeof value.runId === 'string' && value.runId.trim()
        ? value.runId.trim()
        : null;

  if (!conversationId && !runId) {
    return { error: 'benchSession needs a conversationId or a runId' };
  }
  if (value.status !== undefined && !BENCH_RUN_STATUSES.includes(value.status)) {
    return { error: 'benchSession.status is not a known run status' };
  }

  const started =
    current.bench_run_started_at && value.status !== BENCH_RUN_STATUS.RUNNING
      ? current.bench_run_started_at
      : new Date().toISOString();

  return {
    bench_conversation_id: conversationId,
    bench_run_id: runId,
    bench_run_status: value.status ?? current.bench_run_status ?? BENCH_RUN_STATUS.RUNNING,
    bench_run_started_at: started,
  };
}
