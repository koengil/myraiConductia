import { vi } from 'vitest';

/**
 * A recording stand-in for supabase-js `rpc`, as the reader pass record (#370) calls it:
 * `db.rpc(name, args).abortSignal(signal)`, awaited. Answers are taken in order from `answers`
 * (a plain success once they run out); every signal the caller bounded a send with is kept.
 */
export type RpcAnswer = { data: unknown; error: { code: string; message: string } | null };

export function recordingRpc(answers: RpcAnswer[] = []) {
  const signals: AbortSignal[] = [];
  // The parameters only type the recorded calls (rpc.mock.calls).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const rpc = vi.fn((_name: string, _args: Record<string, unknown>) => {
    const answer = Promise.resolve(answers.shift() ?? { data: null, error: null });
    return Object.assign(answer, {
      abortSignal: (signal: AbortSignal) => {
        signals.push(signal);
        return answer;
      },
    });
  });
  /** The pass events sent, in order. */
  const events = () =>
    rpc.mock.calls.map(([, args]) => ({
      event: args.p_event as 'started' | 'finished',
      tenantId: args.p_tenant_id as string,
      detail: args.p_detail as Record<string, unknown>,
    }));
  return { rpc, answers, signals, events };
}
