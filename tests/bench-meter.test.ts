import { describe, expect, it } from 'vitest';

import { meterBenchStream } from '@/lib/ignatious/benchMeter';

function sse(frames: unknown[], chunkSize = 17): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(''));
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(at, at + chunkSize));
      at += chunkSize;
    },
  });
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

const TURN = [
  { type: 'ready', conversationId: 'conv-1', model: 'anthropic/claude-sonnet-5', modelAlias: 'sonnet' },
  { type: 'run', runId: 'run_abc' },
  { type: 'text', text: 'Hello' },
  { type: 'done', costUsd: 0.0421, durationMs: 1200 },
];

describe('meterBenchStream', () => {
  it('hands the client the bytes untouched and reads cost, model and run id off the wire', async () => {
    const original = await drain(sse(TURN));
    const metered = meterBenchStream(sse(TURN));
    const [seen, usage] = await Promise.all([drain(metered.client), metered.usage]);
    expect(seen).toBe(original);
    // The bench's catalog id is stored the way every other ledger writer spells it.
    expect(usage).toEqual({ costUsd: 0.0421, model: 'claude-sonnet-5', runId: 'run_abc' });
  });

  it('still meters when the browser goes away mid-stream', async () => {
    const metered = meterBenchStream(sse(TURN, 9));
    await metered.client.cancel();
    expect(await metered.usage).toMatchObject({ costUsd: 0.0421, runId: 'run_abc' });
  });

  it('keeps a finished turn the bench could not price, as an unpriced call', async () => {
    const metered = meterBenchStream(sse([{ type: 'ready', conversationId: 'c' }, { type: 'run', runId: 'run_x' }, { type: 'done', costUsd: null, durationMs: 5 }]));
    await drain(metered.client);
    expect(await metered.usage).toEqual({ costUsd: null, model: null, runId: 'run_x' });
  });

  it('takes the model a skill run names on done, which may come with no ready frame, and prefers it', async () => {
    const run = meterBenchStream(sse([{ type: 'run', runId: 'run_s' }, { type: 'done', costUsd: 0.03, model: 'anthropic/claude-haiku-5', clampedFrom: 'claude-opus-5' }]));
    await drain(run.client);
    expect(await run.usage).toEqual({ costUsd: 0.03, model: 'claude-haiku-5', runId: 'run_s' });
    const both = meterBenchStream(sse([...TURN.slice(0, 3), { type: 'done', costUsd: 0.01, model: 'claude-haiku-5' }]));
    await drain(both.client);
    expect((await both.usage)?.model).toBe('claude-haiku-5');
  });

  it('reports nothing for a turn that never finished', async () => {
    for (const frames of [[{ type: 'ready', conversationId: 'c' }, { type: 'error', message: 'boom' }], []]) {
      const metered = meterBenchStream(sse(frames));
      await drain(metered.client);
      expect(await metered.usage).toBeNull();
    }
  });

  it('stops waiting on a hung upstream instead of holding the invocation open', async () => {
    const hung = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"ready","conversationId":"c"}\n\n'));
        // never closes, never sends done
      },
    });
    const metered = meterBenchStream(hung, 20);
    expect(await metered.usage).toBeNull();
  });

  it('survives a broken upstream without rejecting', async () => {
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"ready","conversationId":"c"}\n\n'));
        controller.error(new Error('socket hang up'));
      },
    });
    const metered = meterBenchStream(broken);
    await drain(metered.client).catch(() => '');
    expect(await metered.usage).toBeNull();
  });
});
