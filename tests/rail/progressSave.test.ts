import { describe, it, expect, vi, beforeEach } from 'vitest';

import { createProgressSaver, progressSaverFor, type ProgressSaveResult } from '@/lib/rail/progressSave';

// Each fetch waits until the test settles it, so overlapping saves can be ordered.
let pending: { seq: number; settle: (status: number) => void }[];

beforeEach(() => {
  pending = [];
  global.fetch = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolve) => {
    const seq = JSON.parse(String(init?.body)).currentStepSeq as number;
    pending.push({
      seq,
      settle: (status) => resolve({ ok: status < 300, status, json: async () => ({ error: 'refused' }) } as Response),
    });
  })) as unknown as typeof fetch;
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('createProgressSaver', () => {
  it('sends one write at a time, then only the newest waiting position', async () => {
    const results: ProgressSaveResult[] = [];
    const saver = createProgressSaver('D-1');
    saver.subscribe((r) => results.push(r));
    saver.save(2);
    saver.save(3);
    saver.save(4);
    expect(pending.map((p) => p.seq)).toEqual([2]);

    pending[0].settle(200);
    await flush();
    expect(pending.map((p) => p.seq)).toEqual([2, 4]);
    expect(results).toEqual([]); // 2's result is stale: 4 was waiting

    pending[1].settle(200);
    await flush();
    expect(results).toEqual([{ ok: true }]);
    expect(vi.mocked(global.fetch).mock.calls[0][0]).toBe('/api/v1/deals/D-1/progress');
  });

  it('an older failure never reports over a newer position', async () => {
    const results: ProgressSaveResult[] = [];
    const saver = createProgressSaver('D-1');
    saver.subscribe((r) => results.push(r));
    saver.save(2);
    saver.save(3);
    pending[0].settle(500);
    await flush();
    expect(results).toEqual([]);
    pending[1].settle(200);
    await flush();
    expect(results).toEqual([{ ok: true }]);
  });

  it('reports the failed position, with a 4xx message only', async () => {
    const results: ProgressSaveResult[] = [];
    const saver = createProgressSaver('D-1');
    saver.subscribe((r) => results.push(r));
    saver.save(5);
    pending[0].settle(409);
    await flush();
    saver.save(5);
    pending[1].settle(503);
    await flush();
    expect(results).toEqual([
      { ok: false, seq: 5, message: 'refused' },
      { ok: false, seq: 5, message: null },
    ]);
  });

  it('Try again resends the newest position, and does nothing while that one is queued or in flight', async () => {
    const results: ProgressSaveResult[] = [];
    const saver = createProgressSaver('D-1');
    saver.subscribe((r) => results.push(r));
    saver.save(2);
    pending[0].settle(500);
    await flush();
    expect(results).toEqual([{ ok: false, seq: 2, message: null }]);

    saver.save(3); // the user moved on; 3 is in flight
    saver.retry(); // a stale Try again must not queue 2 behind it
    pending[1].settle(200);
    await flush();
    expect(pending.map((p) => p.seq)).toEqual([2, 3]);

    saver.retry(); // 3 saved: Try again resends 3, never 2
    expect(pending.map((p) => p.seq)).toEqual([2, 3, 3]);
  });

  it('keeps one saver per deal for the session, so returning to a deal joins its queue', async () => {
    expect(progressSaverFor('D-9')).toBe(progressSaverFor('D-9'));
    expect(progressSaverFor('D-9')).not.toBe(progressSaverFor('D-10'));
    progressSaverFor('D-9').save(4);
    progressSaverFor('D-9').save(5); // after "navigating away and back": waits behind 4
    expect(pending.map((p) => p.seq)).toEqual([4]);
  });

  it('marks a 404 as not on the deal, without the server text', async () => {
    const results: ProgressSaveResult[] = [];
    const saver = createProgressSaver('D-1');
    saver.subscribe((r) => results.push(r));
    saver.save(3);
    pending[0].settle(404);
    await flush();
    expect(results).toEqual([{ ok: false, seq: 3, message: null, notOnDeal: true }]);
  });

  it('a failure that lands while nobody listens is replayed to the next subscriber', async () => {
    const saver = createProgressSaver('D-1');
    const off = saver.subscribe(() => {});
    saver.save(6);
    off(); // the rail unmounts mid-write
    pending[0].settle(500);
    await flush();
    const results: ProgressSaveResult[] = [];
    saver.subscribe((r) => results.push(r));
    expect(results).toEqual([{ ok: false, seq: 6, message: null }]);
  });
});

