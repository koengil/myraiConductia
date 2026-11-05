import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseAdminClient: () => {
    throw new Error('the worker must not build a client of its own in this test');
  },
}));

import { READER_MODE } from '@/lib/constants/discovery';
import { runOnce } from '../../worker/classify';
import { recordingRpc } from '../helpers/readerPassRpc';

const TENANT = '11111111-1111-4111-8111-111111111111';
const SOURCE = '33333333-3333-4333-8333-333333333331';

/**
 * A fake service client. `feature_flags` answers with `flag` (a row, null for
 * no row, or an error); `content_sources` lists one active mailbox (the run
 * records a reader pass for it, #370); every other table answers "one active
 * registration", so a worker that ignored the flag would go on to read.
 */
function fakeDb(flag: { enabled: boolean } | null | { error: string }) {
  const froms: string[] = [];
  const recorder = recordingRpc();
  const db = {
    rpc: recorder.rpc,
    from: (table: string) => {
      froms.push(table);
      const result = () => {
        if (table === 'feature_flags') {
          return flag && 'error' in flag
            ? { data: null, error: { message: flag.error } }
            : { data: flag, error: null };
        }
        return { data: { tenant_id: TENANT }, error: null };
      };
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        in: () => builder,
        not: () => builder,
        order: () => builder,
        range: () => builder,
        maybeSingle: async () => result(),
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve({
            data:
              table === 'content_sources'
                ? [{ id: SOURCE, tenant_id: TENANT, kind: 'mailbox', provider: 'microsoft', address: 'a@bank.example' }]
                : [],
            error: null,
          }).then(resolve),
      };
      return builder;
    },
  } as unknown as SupabaseClient;
  return { db, froms, events: recorder.events };
}

describe('the classification worker and the deal_discovery flag', () => {
  it.each([
    ['off', { enabled: false }],
    ['missing', null],
    ['unreadable', { error: 'boom' }],
  ])('reads nothing when the flag is %s, and returns why', async (_label, flag) => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { db, froms, events } = fakeDb(flag);
    const summary = await runOnce({ tenantId: TENANT, db, provider: READER_MODE.FIXTURE });
    const passId = events()[0]?.detail.passId;
    expect(summary).toEqual({ tenantId: TENANT, status: 'skipped', reason: 'flag_disabled', passes: [{ sourceId: SOURCE, passId }] });
    // The source list (metadata, so the source's reader pass is recorded, #370), then the flag: no registration,
    // candidate or mail table.
    expect(froms).toEqual(['content_sources', 'feature_flags']);
    expect(events().map((e) => [e.event, e.detail.status ?? null, e.detail.reason ?? null])).toEqual([
      ['started', null, null],
      ['finished', 'disabled', 'flag_off'],
    ]);
  });

  it('goes on to the registration lookup when the flag is on', async () => {
    const { db, froms } = fakeDb({ enabled: true });
    await runOnce({ tenantId: TENANT, db, provider: READER_MODE.FIXTURE }).catch(() => undefined);
    expect(froms.slice(0, 2)).toEqual(['content_sources', 'feature_flags']);
    expect(froms).toContain('graph_reader_registrations');
  });
});
