// @vitest-environment node
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { READER_LIVENESS_SECONDS, READER_PROGRESS_MARK_SECONDS } from '@/lib/constants/discovery';
import { withReadProgress } from '@/lib/discovery/source/progress';

import { progressMarker } from '../../worker/progress';

// Reader liveness (#409): the worker's progress mark, and the transport that feeds it. One rule judges both the
// source row and the reader line (discovery_ingestion_health()); these pin the writer side.

const SOURCE = { id: '33333333-3333-4333-8333-333333333333', tenantId: '11111111-1111-4111-8111-111111111111' };

function recordingDb(result: () => Promise<unknown> = async () => ({ data: null, error: null })) {
  const writes: Array<{ table: string; patch: Record<string, unknown>; filters: Array<[string, unknown]> }> = [];
  const db = {
    from: (table: string) => ({
      update: (patch: Record<string, unknown>) => {
        const write = { table, patch, filters: [] as Array<[string, unknown]> };
        writes.push(write);
        const chain = {
          eq: (column: string, value: unknown) => {
            write.filters.push([column, value]);
            return chain;
          },
          then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => result().then(resolve, reject),
        };
        return chain;
      },
    }),
  } as unknown as SupabaseClient;
  return { db, writes };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the progress mark', () => {
  it('fits the liveness window: the mark interval plus the longest unmarked stretch (a token mint, 785 s)', () => {
    expect(READER_PROGRESS_MARK_SECONDS).toBe(60);
    // A delegated-token mint under #412: signJwt's 6 attempts, each fetching the caller token (15 s) and waiting for
    // its response (60 s), 5 waits of up to 64 s between them, then the 15 s token exchange.
    const mint = 6 * (15 + 60) + 5 * 64 + 15;
    expect(mint).toBe(785);
    expect(mint + READER_PROGRESS_MARK_SECONDS).toBe(845);
    expect(mint + READER_PROGRESS_MARK_SECONDS).toBeLessThan(READER_LIVENESS_SECONDS);
  });

  it('writes reader_progress_at for its own source, at most once a minute', async () => {
    let clock = Date.parse('2026-10-08T12:00:00Z');
    const { db, writes } = recordingDb();
    const mark = progressMarker(db, SOURCE, { now: () => clock });
    mark();
    await flush();
    clock += 59_000;
    mark();
    await flush();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual({
      table: 'content_sources',
      patch: { reader_progress_at: '2026-10-08T12:00:00.000Z' },
      filters: [
        ['id', SOURCE.id],
        ['tenant_id', SOURCE.tenantId],
      ],
    });
    clock += 1_000;
    mark();
    await flush();
    expect(writes.map((w) => w.patch.reader_progress_at)).toEqual(['2026-10-08T12:00:00.000Z', '2026-10-08T12:01:00.000Z']);
  });

  it('never fails the read: a failed write is dropped, and one write runs at a time', async () => {
    let clock = 0;
    let release!: () => void;
    const { db, writes } = recordingDb(() => new Promise((_, reject) => (release = () => reject(new Error('db down')))));
    const mark = progressMarker(db, SOURCE, { now: () => clock });
    expect(() => mark()).not.toThrow();
    clock += 120_000;
    mark(); // the first write is still running
    expect(writes).toHaveLength(1);
    await flush();
    release();
    await flush();
    clock += 120_000;
    mark();
    expect(writes).toHaveLength(2);
  });
});

describe('a hung progress write', () => {
  it('is given up on after the write timeout, so the next mark still writes', async () => {
    let clock = 0;
    const { db, writes } = recordingDb(() => new Promise(() => {}));
    const mark = progressMarker(db, SOURCE, { now: () => clock, timeoutMs: 20 });
    mark();
    await new Promise((resolve) => setTimeout(resolve, 40));
    clock += 120_000;
    mark();
    expect(writes).toHaveLength(2);
  });
});

describe('the transport that feeds it', () => {
  it('marks after every token and every successful response, and not after a failed one', async () => {
    const onProgress = vi.fn();
    const statuses = [200, 503];
    const http = withReadProgress(
      { getToken: async () => 'tok', fetchImpl: (async () => new Response('{}', { status: statuses.shift() })) as typeof fetch },
      onProgress,
    );
    expect(await http.getToken()).toBe('tok');
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect((await http.fetchImpl!('https://gmail.googleapis.com/x')).status).toBe(200);
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect((await http.fetchImpl!('https://gmail.googleapis.com/x')).status).toBe(503);
    expect(onProgress).toHaveBeenCalledTimes(2);
  });

  it('passes the token request through, and leaves a transport with no callback as it is', async () => {
    const getToken = vi.fn(async (options?: { forceRefresh?: boolean }) => (options?.forceRefresh ? 'fresh' : 'cached'));
    const http = withReadProgress({ getToken }, () => undefined);
    expect(await http.getToken({ forceRefresh: true })).toBe('fresh');
    const bare = { getToken };
    expect(withReadProgress(bare)).toBe(bare);
  });
});
