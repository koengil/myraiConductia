// @vitest-environment node
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import type { ExclusionPolicy, PolicyRule } from '@/lib/discovery/exclusion/types';
import { collisionLedgerRows, ledgerRows, persistItems, readThreadTaint, skippedLedgerRows } from '@/lib/discovery/persist';
import type { RoutedItem } from '@/lib/discovery/route/firmRules';

// #263, phase 3: what the worker reads back (readThreadTaint) and what the page writes (the taint insert and the
// ledger's thread id). Both are exercised over a recording client; the table's own rules (first provenance wins,
// no update, service role only) are held by supabase/tests/discovery_exclusion_policy.sql on a real database.

const SOURCE = '33333333-3333-4333-8333-333333333331';
const OTHER_SOURCE = '33333333-3333-4333-8333-333333333332';
const RUN = '44444444-4444-4444-8444-444444444441';

const rule = (id: string, scope: 'thread' | 'message'): PolicyRule => ({ id, category: 'privileged', scope, kind: 'label', names: ['Privileged'] });
const policy = (...rules: PolicyRule[]): ExclusionPolicy => ({ version: 3, rules });

type Row = { provider_thread_id: string; rule_id: string };

/** A client over the taint table: the rows it holds, paged by `range`, filtered by the one `eq` asked. */
function taintDb(rows: Array<Row & { source_id: string }>, error: { message: string } | null = null) {
  const asked: Array<{ table: string; filters: Array<[string, unknown]>; range: [number, number]; order: string[] }> = [];
  const from = (table: string) => {
    const filters: Array<[string, unknown]> = [];
    const order: string[] = [];
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (column: string, value: unknown) => {
        filters.push([column, value]);
        return builder;
      },
      order: (column: string) => {
        order.push(column);
        return builder;
      },
      range: (first: number, last: number) => {
        asked.push({ table, filters, range: [first, last], order });
        const held = rows.filter((row) => filters.every(([column, value]) => (row as Record<string, unknown>)[column] === value));
        return Promise.resolve({ data: error ? null : held.slice(first, last + 1), error });
      },
    };
    return builder;
  };
  return { db: { from } as unknown as SupabaseClient, asked };
}

describe('reading the thread taint a source holds (readThreadTaint)', () => {
  const rows = [
    { source_id: SOURCE, provider_thread_id: 't1', rule_id: 'privileged' },
    { source_id: SOURCE, provider_thread_id: 't1', rule_id: 'counsel' },
    { source_id: SOURCE, provider_thread_id: 't2', rule_id: 'old-condition' },
    { source_id: SOURCE, provider_thread_id: 't3', rule_id: 'message-now' },
    { source_id: OTHER_SOURCE, provider_thread_id: 'u1', rule_id: 'privileged' },
  ];

  it('keeps only the current version\'s thread-scoped rules, so narrowing or removing a rule stops its old taints', async () => {
    const { db, asked } = taintDb(rows);
    const taint = await readThreadTaint(db, SOURCE, policy(rule('privileged', 'thread'), rule('counsel', 'thread'), rule('message-now', 'message')));
    // t2's rule is gone from the policy and t3's is message-scoped now: neither taints anything.
    expect(taint).toEqual(new Map([['t1', new Set(['privileged', 'counsel'])]]));
    expect(asked[0]).toMatchObject({ table: 'discovery_thread_taints', filters: [['source_id', SOURCE]] });
  });

  it("reads one source's taint only: a thread id is per mailbox", async () => {
    const { db } = taintDb(rows);
    expect(await readThreadTaint(db, OTHER_SOURCE, policy(rule('privileged', 'thread')))).toEqual(new Map([['u1', new Set(['privileged'])]]));
    expect((await readThreadTaint(db, 'no-such-source', policy(rule('privileged', 'thread')))).size).toBe(0);
  });

  it('asks for nothing when the policy has no thread-scoped rule', async () => {
    const { db, asked } = taintDb(rows);
    expect((await readThreadTaint(db, SOURCE, policy(rule('message-now', 'message')))).size).toBe(0);
    expect((await readThreadTaint(db, SOURCE, policy())).size).toBe(0);
    expect(asked).toEqual([]);
  });

  it('pages in a stable order past the 1,000-row limit, and loses none of a large mailbox', async () => {
    const many = Array.from({ length: 2300 }, (_, i) => ({
      source_id: SOURCE,
      provider_thread_id: `thread-${String(i).padStart(5, '0')}`,
      rule_id: 'privileged',
    }));
    const { db, asked } = taintDb(many);
    const taint = await readThreadTaint(db, SOURCE, policy(rule('privileged', 'thread')));
    expect(taint.size).toBe(2300);
    expect(asked.map((a) => a.range)).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
    // The primary key's order, on every page, so two pages never overlap or skip a row.
    for (const request of asked) expect(request.order).toEqual(['provider_thread_id', 'rule_id']);
  });

  it('stops after a page of exactly the limit only when the next one is empty', async () => {
    const exact = Array.from({ length: 1000 }, (_, i) => ({ source_id: SOURCE, provider_thread_id: `t${i}`, rule_id: 'privileged' }));
    const { db, asked } = taintDb(exact);
    expect((await readThreadTaint(db, SOURCE, policy(rule('privileged', 'thread')))).size).toBe(1000);
    expect(asked.map((a) => a.range)).toEqual([[0, 999], [1000, 1999]]);
  });

  it('fails the pass on a database error rather than reading under no taint', async () => {
    const { db } = taintDb([], { message: 'connection reset' });
    await expect(readThreadTaint(db, SOURCE, policy(rule('privileged', 'thread')))).rejects.toThrow('discovery_thread_taints read failed');
  });
});

describe('writing a page: the taints and the ledger thread id', () => {
  const routedItem = (providerThreadId: string | undefined): RoutedItem =>
    ({
      item: {
        internetMessageId: '<m1@x>',
        conversationId: 'c1',
        subject: 's',
        threadSubject: 's',
        sentAt: null,
        participants: [],
        bodyText: 'b',
        contentHash: 'h',
      },
      observations: [{ sourceId: SOURCE, providerItemId: 'p1', ...(providerThreadId !== undefined ? { providerThreadId } : {}) }],
      routes: [],
    }) as unknown as RoutedItem;

  it('carries the thread id on an unrouted row (read, not stored), and leaves it null when the provider has none', () => {
    expect(ledgerRows([routedItem('thread-9')], RUN)[0]).toMatchObject({
      decision: 'unrouted',
      provider_thread_id: 'thread-9',
      policy_version: null,
      exclusion_rule: null,
    });
    expect(ledgerRows([routedItem(undefined)], RUN)[0].provider_thread_id).toBeNull();
  });

  it('carries the thread id on an id collision too, with no policy fields', () => {
    const [row] = collisionLedgerRows(
      [{ sourceId: SOURCE, providerItemId: 'p1', providerThreadId: 'thread-9', key: '<m1@x>', itemHash: 'h', similarity: 0.5, lengthRatio: 0.9 }],
      RUN,
    );
    expect(row).toMatchObject({ skip_reason: 'id_collision', provider_thread_id: 'thread-9', policy_version: null, exclusion_rule: null });
  });

  it('keeps a policy skip\'s thread, version and rule together', () => {
    const [row] = skippedLedgerRows(
      [{ sourceId: SOURCE, providerItemId: 'p1', providerThreadId: 'thread-9', itemHash: 'h', reason: 'policy_thread_excluded', policy: { version: 3, ruleId: 'privileged' } }],
      RUN,
    );
    expect(row).toMatchObject({ skip_reason: 'policy_thread_excluded', provider_thread_id: 'thread-9', policy_version: 3, exclusion_rule: 'privileged' });
  });

  /** A recording client: every write in order, with its options. */
  function recorder() {
    const writes: Array<{ table: string; op: string; rows: unknown; options?: Record<string, unknown> }> = [];
    const rpc = vi.fn(async (name: string, args: unknown) => {
      writes.push({ table: name, op: 'rpc', rows: args });
      return { data: null, error: null };
    });
    const from = (table: string) => ({
      upsert: (rows: unknown, options?: Record<string, unknown>) => {
        writes.push({ table, op: 'upsert', rows, options });
        return Promise.resolve({ data: null, error: null });
      },
    });
    return { db: { from, rpc } as unknown as SupabaseClient, writes };
  }

  it("writes the page's taints and its policy skips in one database call, so neither commits without the other (audit C3)", async () => {
    const { db, writes } = recorder();
    await persistItems(db, {
      tenantId: '11111111-1111-4111-8111-111111111111',
      runId: RUN,
      routed: [],
      skipped: [
        { sourceId: SOURCE, providerItemId: 'p1', providerThreadId: 'thread-9', itemHash: 'h', reason: 'policy_excluded', policy: { version: 3, ruleId: 'privileged' } },
        { sourceId: SOURCE, providerItemId: 'p2', providerThreadId: 'thread-9', itemHash: 'h2', reason: 'policy_thread_excluded', policy: { version: 3, ruleId: 'privileged' } },
      ],
      threadTaints: [{ sourceId: SOURCE, providerThreadId: 'thread-9', providerItemId: 'p1', ruleId: 'privileged', policyVersion: 3 }],
    });
    // No separate write to the taint table: a taint is inserted insert-only (first provenance wins) by the function.
    expect(writes.some((w) => w.table === 'discovery_thread_taints')).toBe(false);
    const calls = writes.filter((w) => w.op === 'rpc' && w.table === 'discovery_ledger_record_policy_skips');
    expect(calls).toHaveLength(1);
    expect(calls[0].rows).toMatchObject({
      p_rows: [{ provider_item_id: 'p1', skip_reason: 'policy_excluded' }, { provider_item_id: 'p2', skip_reason: 'policy_thread_excluded' }],
      p_taints: [{ source_id: SOURCE, provider_thread_id: 'thread-9', rule_id: 'privileged', policy_version: 3, provider_item_id: 'p1', run_id: RUN }],
    });
  });

  it('makes no call when the page has neither, and fails the page when the call fails', async () => {
    const none = recorder();
    await persistItems(none.db, { tenantId: 'x', runId: RUN, routed: [] });
    expect(none.writes.some((w) => w.op === 'rpc')).toBe(false);

    const failing = {
      from: () => ({ upsert: () => Promise.resolve({ data: null, error: null }) }),
      rpc: async () => ({ data: null, error: { message: 'boom' } }),
    } as unknown as SupabaseClient;
    await expect(
      persistItems(failing, {
        tenantId: 'x',
        runId: RUN,
        routed: [],
        threadTaints: [{ sourceId: SOURCE, providerThreadId: 't', providerItemId: 'p', ruleId: 'r', policyVersion: 1 }],
      }),
    ).rejects.toThrow('discovery persist: discovery_ledger_record_policy_skips failed');
  });
});
