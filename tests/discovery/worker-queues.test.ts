// @vitest-environment node
import type { PgBoss } from 'pg-boss';
import { describe, expect, it } from 'vitest';

import { QUEUE, QUEUE_OPTIONS, ensureQueues } from '../../worker/boss';

// C6: a crashed worker frees its mailbox through the sync queue's heartbeat, not the hour-long expiry. create_queue
// never changes an existing queue, so ensureQueues also updates the heartbeat in place.
describe('the discovery queues', () => {
  it('creates every queue and gives the sync queue its heartbeat once, after its create', async () => {
    const calls: unknown[][] = [];
    const boss = {
      createQueue: async (name: string) => void calls.push(['create', name]),
      updateQueue: async (name: string, options: unknown) => void calls.push(['update', name, options]),
    } as unknown as PgBoss;
    await ensureQueues(boss);

    expect(calls.filter((c) => c[0] === 'update')).toEqual([['update', QUEUE.SYNC, { heartbeatSeconds: 120 }]]);
    expect(calls.findIndex((c) => c[0] === 'update')).toBe(calls.findIndex((c) => c[0] === 'create' && c[1] === QUEUE.SYNC) + 1);
    expect(calls.filter((c) => c[0] === 'create')).toHaveLength(Object.keys(QUEUE_OPTIONS).length);
  });

  it('beats the expiry with a heartbeat, so a dead process is noticed first', () => {
    expect(QUEUE_OPTIONS[QUEUE.SYNC].heartbeatSeconds).toBeLessThan(QUEUE_OPTIONS[QUEUE.SYNC].expireInSeconds);
  });
});
