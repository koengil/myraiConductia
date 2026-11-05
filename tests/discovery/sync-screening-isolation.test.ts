// @vitest-environment node
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The screen throws for one message only: the others still count, the page still persists.
vi.mock('@/lib/compliance/screenIncoming', async () => {
  const actual = await vi.importActual<typeof import('@/lib/compliance/screenIncoming')>('@/lib/compliance/screenIncoming');
  return {
    ...actual,
    screenIncomingMessage: (...args: Parameters<typeof actual.screenIncomingMessage>) => {
      if (args[0].internetMessageId.includes('boom')) throw new Error('screen exploded');
      return actual.screenIncomingMessage(...args);
    },
  };
});

import { MAILBOX_PROVIDER, SOURCE_KIND } from '@/lib/constants/discovery';
import type { ContentSource, MailMessage, SourceItemPage } from '@/lib/discovery/source/types';
import { RoutingContext, syncSource, type SyncSource } from '../../worker/sync';

// Screening is observe-only (Martin's review of PR #405; Guillermo's of PR #416).

afterEach(() => {
  vi.restoreAllMocks();
});

function stubDb() {
  const ok = { data: [], error: null };
  return {
    // An empty ledger: an insert returns every row it is given (every sighting is new).
    from: () => ({
      upsert: (rows: unknown) => Object.assign(Promise.resolve(ok), { select: async () => ({ data: rows, error: null }) }),
      insert: async () => ok,
      update: () => ({ eq: async () => ok }),
      // The message index read (#461) finds nothing: every message is processed.
      select: () => ({ eq: () => ({ eq: () => ({ in: async () => ok }) }) }),
    }),
    rpc: async () => ok,
  } as unknown as SupabaseClient;
}

const source: SyncSource = {
  id: '33333333-3333-4333-8333-333333333333',
  tenantId: '11111111-1111-4111-8111-111111111111',
  kind: SOURCE_KIND.MAILBOX,
  provider: MAILBOX_PROVIDER.GOOGLE,
  address: 'banker@bank.example',
  ownerUserId: null,
  deltaCheckpoint: null,
  backfillStartedAt: null,
  backfillCompletedAt: null,
  lastSyncedAt: null,
  historyExpiryStreak: 0,
};

const mail = (id: string, subject: string, content: string) =>
  ({
    id,
    internetMessageId: `<${id}@bank.example>`,
    conversationId: `conv-${id}`,
    subject,
    body: { contentType: 'text', content },
    from: { emailAddress: { address: 'someone@outside.example', name: 'Someone' } },
    toRecipients: [{ emailAddress: { address: 'banker@bank.example', name: 'Banker' } }],
    ccRecipients: [],
    sentDateTime: '2026-10-07T10:00:00Z',
  }) as unknown as MailMessage;

const onePage = (items: MailMessage[]): ContentSource => ({
  kind: SOURCE_KIND.MAILBOX,
  backfill: () =>
    (async function* (): AsyncGenerator<SourceItemPage> {
      yield { items, nextCheckpoint: null } as unknown as SourceItemPage;
    })(),
  delta: () => (async function* (): AsyncGenerator<SourceItemPage> {})(),
});

describe('a screening failure in the sync worker', () => {
  it('counts only the failing message as unscreened, completes the sync and warns without content', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reader = onePage([
      mail('boom', 'Anything', 'This one makes the screen throw.'),
      mail('own', 'Heads up', 'Our internal valuation model puts the business at 11x EBITDA.'),
    ]);
    const result = await syncSource(stubDb(), { source: { ...source }, reader, runId: 'run-x', context: new RoutingContext() });
    expect(result.status).toBe('complete');
    expect(result.pages).toBe(1);
    expect(result.screening).toEqual({ screened: 1, flagged: 1 });
    expect(warn).toHaveBeenCalledWith(JSON.stringify({ evt: 'screen_failed', source: source.id, count: 1 }));
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/@|EBITDA|valuation/);
  });
});
