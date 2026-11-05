// @vitest-environment node
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import { MAILBOX_PROVIDER, SOURCE_KIND } from '@/lib/constants/discovery';
import type { ContentSource, MailMessage, SourceItemPage } from '@/lib/discovery/source/types';
import { RoutingContext, syncSource, type SyncSource } from '../../worker/sync';

// Incoming-mail screening runs on every message a page reads (plan v5 W3),
// with the send-time rules only, and reports counts: no content, no store.
// Each message is counted once: the first time the ledger sees it.

type LedgerKey = { source_id: string; provider_item_id: string };

/** A db that keeps the routing ledger's keys, so an insert that skips conflicts returns only the rows it wrote. */
function stubDb(ledger = new Set<string>()) {
  const ok = { data: [], error: null };
  const key = (row: LedgerKey) => `${row.source_id}|${row.provider_item_id}`;
  return {
    from: (table: string) => ({
      upsert: (rows: LedgerKey[], options?: { ignoreDuplicates?: boolean }) => {
        const written = table === 'routing_ledger' && options?.ignoreDuplicates ? rows.filter((row) => !ledger.has(key(row))) : [];
        if (table === 'routing_ledger') for (const row of rows) ledger.add(key(row));
        return Object.assign(Promise.resolve(ok), { select: async () => ({ data: written, error: null }) });
      },
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

describe('incoming-mail screening in the sync worker', () => {
  it('counts the messages read and the ones the send-time rules would flag, forwards included', async () => {
    const reader = onePage([
      mail('clean', 'Lunch', 'See you at noon.'),
      mail('own', 'Heads up', 'Our internal valuation model puts the business at 11x EBITDA.'),
      mail('fwd', 'Fwd: Numbers', 'FYI, see below.\n\n---------- Forwarded message ----------\nOur internal valuation model puts the business at 11x EBITDA.'),
    ]);
    const result = await syncSource(stubDb(), { source: { ...source }, reader, runId: 'run-1', context: new RoutingContext() });
    expect(result.screening).toEqual({ screened: 3, flagged: 2 });
  });

  it('screens a repeated Message-ID with the first sighting\'s forwarded block, the one dedupe keeps', async () => {
    const fwd = (content: string) => `FYI\n\n---------- Forwarded message ----------\n${content}`;
    const reader = onePage([
      mail('dup', 'Fwd: Lunch', fwd('See you at noon.')),
      mail('dup', 'Fwd: Numbers', fwd('Our internal valuation model puts the business at 11x EBITDA.')),
    ]);
    const result = await syncSource(stubDb(), { source: { ...source }, reader, runId: 'run-3', context: new RoutingContext() });
    expect(result.screening).toEqual({ screened: 1, flagged: 0 });
  });

  it('counts nothing again when the same page is read again (a restart, a re-backfill, a delta overlap)', async () => {
    const db = stubDb();
    const page = () => onePage([mail('clean', 'Lunch', 'See you at noon.'), mail('own', 'Heads up', 'Our internal valuation model puts the business at 11x EBITDA.')]);
    const first = await syncSource(db, { source: { ...source }, reader: page(), runId: 'run-4', context: new RoutingContext() });
    expect(first.screening).toEqual({ screened: 2, flagged: 1 });
    const again = await syncSource(db, { source: { ...source }, reader: page(), runId: 'run-5', context: new RoutingContext() });
    expect(again.screening).toEqual({ screened: 0, flagged: 0 });
  });

  it('screens only the new messages of a page that mixes new and already ledgered ones', async () => {
    const db = stubDb();
    await syncSource(db, {
      source: { ...source },
      reader: onePage([mail('own', 'Heads up', 'Our internal valuation model puts the business at 11x EBITDA.')]),
      runId: 'run-6',
      context: new RoutingContext(),
    });
    const mixed = onePage([
      mail('own', 'Heads up', 'Our internal valuation model puts the business at 11x EBITDA.'),
      mail('clean', 'Lunch', 'See you at noon.'),
      mail('fresh', 'Numbers', 'Our internal valuation model puts the business at 12x EBITDA.'),
    ]);
    const result = await syncSource(db, { source: { ...source }, reader: mixed, runId: 'run-7', context: new RoutingContext() });
    expect(result.screening).toEqual({ screened: 2, flagged: 1 });
  });

  it('reports zero when nothing is read', async () => {
    const result = await syncSource(stubDb(), { source: { ...source }, reader: onePage([]), runId: 'run-2', context: new RoutingContext() });
    expect(result.screening).toEqual({ screened: 0, flagged: 0 });
  });
});
