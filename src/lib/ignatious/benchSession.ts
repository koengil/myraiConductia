import { BENCH_RUN_STATUS, type BenchRunStatus } from '@/lib/constants/dealSteps';

export type BenchSession = {
  conversationId: string | null;
  runId: string | null;
  status: BenchRunStatus | null;
  startedAt: string | null;
};

export type BenchSessionPatch = {
  conversationId?: string | null;
  runId?: string | null;
  status?: BenchRunStatus;
};

export type StepState = {
  work: Record<string, unknown>;
  session: BenchSession | null;
};

function stepPath(dealId: string, stepId: string): string {
  return `/api/v1/deals/${encodeURIComponent(dealId)}/steps/${encodeURIComponent(stepId)}`;
}

export function normalizeBenchSession(raw: unknown): BenchSession | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  const conversationId = typeof rec.conversationId === 'string' ? rec.conversationId : null;
  const runId = typeof rec.runId === 'string' ? rec.runId : null;
  if (!conversationId && !runId) return null;
  const status = Object.values(BENCH_RUN_STATUS).find((value) => value === rec.status) ?? null;
  return {
    conversationId,
    runId,
    status,
    startedAt: typeof rec.startedAt === 'string' ? rec.startedAt : null,
  };
}

export async function readStepState(dealId: string, stepId: string): Promise<StepState> {
  const response = await fetch(stepPath(dealId, stepId), {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) return { work: {}, session: null };
  const body = (await response.json()) as {
    step?: { work?: Record<string, unknown>; benchSession?: unknown };
  };
  return {
    work: body.step?.work ?? {},
    session: normalizeBenchSession(body.step?.benchSession),
  };
}

export async function patchStep(
  dealId: string,
  stepId: string,
  body: { work?: Record<string, unknown>; benchSession?: BenchSessionPatch | null },
): Promise<boolean> {
  const response = await fetch(stepPath(dealId, stepId), {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return response.ok;
}

export function elapsedLabel(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
}
