// @vitest-environment node
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import { MAILBOX_PROVIDER, READER_MODE } from '@/lib/constants/discovery';
import { loadExclusionPolicy } from '@/lib/discovery/exclusion/load';

/** A fake service client over the policy table: the rows it holds, newest first, and the one filter asked. */
function fakeDb(rows: unknown[], error: { message: string } | null = null) {
  const asked: Array<[string, unknown]> = [];
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: (column: string, value: unknown) => {
      asked.push([column, value]);
      return builder;
    },
    order: () => builder,
    limit: (n: number) => Promise.resolve({ data: error ? null : rows.slice(0, n), error }),
  };
  return { db: { from: () => builder } as unknown as SupabaseClient, asked };
}

const RULE = { id: 'outside-counsel', category: 'never_read', scope: 'message', kind: 'participant_domain', domains: ['counsel.example'] };
const TENANT = '11111111-1111-4111-8111-111111111111';

describe('loading the tenant exclusion policy', () => {
  it('returns the current version, validated, for the asked tenant', async () => {
    const { db, asked } = fakeDb([{ version: 3, rules: [RULE] }]);
    expect(await loadExclusionPolicy(db, TENANT, READER_MODE.LIVE, MAILBOX_PROVIDER.GOOGLE)).toEqual({ version: 3, rules: [RULE] });
    expect(asked).toEqual([['tenant_id', TENANT]]);
  });

  it('is version 0 with no stored version only where no live Gmail read can follow: fixture mode, or Microsoft in graph mode', async () => {
    const { db } = fakeDb([]);
    for (const provider of [MAILBOX_PROVIDER.GOOGLE, MAILBOX_PROVIDER.MICROSOFT]) {
      expect(await loadExclusionPolicy(db, TENANT, READER_MODE.LIVE, provider)).toEqual({ unavailable: 'missing' });
      expect(await loadExclusionPolicy(db, TENANT, READER_MODE.FIXTURE, provider)).toEqual({ version: 0, rules: [] });
    }
    // The Gmail factory replays in fixture mode only: any other mode reads live Gmail, so it needs an audited version.
    expect(await loadExclusionPolicy(db, TENANT, READER_MODE.GRAPH, MAILBOX_PROVIDER.GOOGLE)).toEqual({ unavailable: 'missing' });
    // The Microsoft reader enforces no rule yet and refuses a non-empty policy (R9), so the Graph cassette reads as before.
    expect(await loadExclusionPolicy(db, TENANT, READER_MODE.GRAPH, MAILBOX_PROVIDER.MICROSOFT)).toEqual({ version: 0, rules: [] });
  });

  it('reads a thread-scoped rule, and a stored rule without a scope as a thread rule', async () => {
    const { scope: _scope, ...unscoped } = RULE;
    void _scope;
    const { db } = fakeDb([{ version: 2, rules: [{ ...RULE, scope: 'thread' }, { ...unscoped, id: 'other', domains: ['law.example'] }] }]);
    expect(await loadExclusionPolicy(db, TENANT, READER_MODE.LIVE, MAILBOX_PROVIDER.GOOGLE)).toMatchObject({
      version: 2,
      rules: [{ id: 'outside-counsel', scope: 'thread' }, { id: 'other', scope: 'thread' }],
    });
  });

  it('accepts an empty current version in live mode: an empty policy is a deliberate one', async () => {
    const { db } = fakeDb([{ version: 1, rules: [] }]);
    expect(await loadExclusionPolicy(db, TENANT, READER_MODE.LIVE, MAILBOX_PROVIDER.GOOGLE)).toEqual({ version: 1, rules: [] });
  });

  it('is unavailable "invalid", in every mode, when the current version fails validation, and never throws for content', async () => {
    for (const rules of [[{ ...RULE, scope: 'conversation' }], [{ ...RULE, domain: 'x' }], 'not a list', null]) {
      const { db } = fakeDb([{ version: 2, rules }]);
      for (const mode of [READER_MODE.LIVE, READER_MODE.FIXTURE, READER_MODE.GRAPH]) {
        expect(await loadExclusionPolicy(db, TENANT, mode, MAILBOX_PROVIDER.GOOGLE)).toEqual({ unavailable: 'invalid' });
      }
    }
  });

  it('still throws on a database error', async () => {
    const { db } = fakeDb([], { message: 'connection reset' });
    await expect(loadExclusionPolicy(db, TENANT, READER_MODE.LIVE, MAILBOX_PROVIDER.GOOGLE)).rejects.toThrow('policy read failed');
  });
});
