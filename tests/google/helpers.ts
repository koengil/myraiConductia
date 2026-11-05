import type { GoogleHttpOptions } from '@/lib/google/reader/http';

export type Reply = { status: number; headers?: Record<string, string>; body?: unknown };

/** A fetch that answers from a script in order, and records what it was asked. */
export function scripted(replies: Reply[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const queue = [...replies];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const reply = queue.shift();
    if (!reply) throw new Error(`scripted fetch: no reply left for ${String(input)}`);
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'Content-Type': 'application/json', ...reply.headers },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** Options with a recording token source and a sleep that never waits. */
export function options(fetchImpl: typeof fetch, extra: Partial<GoogleHttpOptions> = {}) {
  const tokenCalls: Array<{ forceRefresh?: boolean } | undefined> = [];
  const sleeps: number[] = [];
  let n = 0;
  const opts: GoogleHttpOptions = {
    getToken: async (o) => {
      tokenCalls.push(o);
      n += 1;
      return `token-${n}`;
    },
    fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    ...extra,
  };
  return { opts, tokenCalls, sleeps };
}
