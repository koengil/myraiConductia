// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The guard builds its own service client, so the seam is the admin-client module.
const admin = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseAdminClient: () => ({ rpc: admin.rpc }),
}));

import { MAILBOX_PROVIDER, READER_MODE, SOURCE_KIND } from '@/lib/constants/discovery';
import { getGoogleContentSource } from '@/lib/google/reader';
import {
  createGmailMailContentSource,
  MAX_GMAIL_REQUESTS_PER_PAGE,
  parseCheckpoint,
} from '@/lib/google/reader/mail';
import { createGuardedContentSource, MailboxAccessRefusedError } from '@/lib/mailboxAccess';
import type { SourceItemPage } from '@/lib/discovery/source/types';

import { NO_EXCLUSION, exclusionWith, domainRule } from './exclusion';
import { fakeGmail, threadOf } from './fakeGmail';

const ADDRESS = 'storm.duncan@bank.example';

beforeEach(() => {
  admin.rpc.mockReset();
});

/** Reads every page and records how many requests each page cost. */
async function pagesWithCost(
  gmail: ReturnType<typeof fakeGmail>,
  checkpoint: string | null = null,
  stopAfter = Infinity,
  exclusion = NO_EXCLUSION,
) {
  const reader = createGmailMailContentSource({ httpFor: async () => gmail.http, exclusion });
  const pages: SourceItemPage[] = [];
  const costs: number[] = [];
  let before = gmail.log.length;
  for await (const page of reader.backfill(gmail.source, checkpoint)) {
    pages.push(page);
    costs.push(gmail.log.length - before);
    before = gmail.log.length;
    if (pages.length >= stopAfter) break;
  }
  return { pages, costs };
}
const idsOf = (pages: SourceItemPage[]) => pages.flatMap((p) => p.items.map((m) => m.id));

describe('a Gmail page never spans more than 25 requests (C1, plan D5)', () => {
  it('still costs at most 25 requests per page with excluded messages in the page, and an excluded message costs none', async () => {
    const messages = Array.from({ length: 40 }, (_, i) => ({
      id: `m${i + 1}`,
      internalDate: 1000 + i,
      ...(i % 2 === 1 ? { to: [{ address: 'partner@counsel.example' }] } : {}),
    }));
    const gmail = fakeGmail({ address: ADDRESS, threads: [{ id: 't', messages }] });
    const { pages, costs } = await pagesWithCost(gmail, null, Infinity, exclusionWith([domainRule('counsel', 'counsel.example')]));
    expect(Math.max(...costs)).toBeLessThanOrEqual(MAX_GMAIL_REQUESTS_PER_PAGE);
    expect(idsOf(pages)).toHaveLength(20);
    expect(pages.flatMap((p) => p.skipped ?? [])).toHaveLength(20);
    expect(gmail.log.filter((l) => l.startsWith('raw:'))).toHaveLength(20);
  });

  it('splits a 40-message thread across pages by next message id', async () => {
    const gmail = fakeGmail({ address: ADDRESS, threads: [threadOf('big', 40)] });
    const { pages, costs } = await pagesWithCost(gmail);
    expect(Math.max(...costs)).toBeLessThanOrEqual(MAX_GMAIL_REQUESTS_PER_PAGE);
    expect(pages.length).toBeGreaterThan(1);
    // Nothing lost and nothing twice.
    expect(idsOf(pages)).toEqual(Array.from({ length: 40 }, (_, i) => `big-m${i + 1}`));
    // The mid-thread checkpoint names the exact next message.
    const mid = parseCheckpoint(pages[0].nextCheckpoint);
    expect(mid).toMatchObject({ phase: 'backfill', nextThreadId: 'big' });
    expect(mid.nextMessageId).toBe(`big-m${pages[0].items.length + 1}`);
  });

  it('bounds a mailbox of many small threads too, counting the filtered ones', async () => {
    const threads = Array.from({ length: 60 }, (_, i) => threadOf(`t${i + 1}`, 1));
    const gmail = fakeGmail({ address: ADDRESS, threads, listPageSize: 25 });
    const { pages, costs } = await pagesWithCost(gmail);
    expect(Math.max(...costs)).toBeLessThanOrEqual(MAX_GMAIL_REQUESTS_PER_PAGE);
    expect(idsOf(pages)).toHaveLength(60);
  });

  it('resumes from a mid-thread checkpoint without re-reading a message', async () => {
    const threads = [threadOf('a', 3), threadOf('big', 40), threadOf('z', 2)];
    const first = fakeGmail({ address: ADDRESS, threads });
    const run1 = await pagesWithCost(first, null, 1); // killed after the first page
    const checkpoint = run1.pages[0].nextCheckpoint;
    expect(parseCheckpoint(checkpoint).phase).toBe('backfill');

    const second = fakeGmail({ address: ADDRESS, threads });
    const run2 = await pagesWithCost(second, checkpoint);
    const rawFetches = [...first.log, ...second.log].filter((l) => l.startsWith('raw:'));
    // Every message was fetched raw exactly once across the two runs.
    expect(rawFetches).toHaveLength(45);
    expect(new Set(rawFetches).size).toBe(45);
    expect(idsOf([...run1.pages, ...run2.pages])).toEqual([
      'a-m1', 'a-m2', 'a-m3',
      ...Array.from({ length: 40 }, (_, i) => `big-m${i + 1}`),
      'z-m1', 'z-m2',
    ]);
    // A resumed run does not ask for the profile again: the history id is in the checkpoint.
    expect(second.log).not.toContain('profile');
    expect(parseCheckpoint(run2.pages[run2.pages.length - 1].nextCheckpoint).historyId).toBe(first.historyId);
  });

  it('holds with a window too: pre-window messages cost no request, and a resume keeps the window (#353)', async () => {
    const floor = Date.UTC(2026, 6, 17);
    // 40 messages, the odd ones before the window; then 30 one-message threads in it.
    const big = { id: 'big', messages: Array.from({ length: 40 }, (_, i) => ({ id: `big-m${i + 1}`, internalDate: floor + (i % 2 === 0 ? -1 - i : i) })) };
    const threads = [big, ...Array.from({ length: 30 }, (_, i) => ({ id: `t${i + 1}`, messages: [{ id: `t${i + 1}-m`, internalDate: floor + i }] }))];
    const first = fakeGmail({ address: ADDRESS, threads, listPageSize: 25, backfillSince: '2026-07-17' });
    const run1 = await pagesWithCost(first, null, 1);
    const second = fakeGmail({ address: ADDRESS, threads, listPageSize: 25, backfillSince: '2026-07-17' });
    const run2 = await pagesWithCost(second, run1.pages[0].nextCheckpoint);
    expect(Math.max(...run1.costs, ...run2.costs)).toBeLessThanOrEqual(MAX_GMAIL_REQUESTS_PER_PAGE);
    const inWindow = big.messages.filter((m) => m.internalDate >= floor).map((m) => m.id);
    expect(idsOf([...run1.pages, ...run2.pages])).toEqual([...inWindow, ...threads.slice(1).map((t) => t.messages[0].id)]);
    // Only in-window messages were fetched raw, each once.
    const rawFetches = [...first.log, ...second.log].filter((l) => l.startsWith('raw:'));
    expect(rawFetches).toHaveLength(20 + 30);
    expect(new Set(rawFetches).size).toBe(50);
  });

  it('stops before any request of page 2 when the guard refuses after page 1', async () => {
    // Guard answers: allowed before page 1, refused before page 2.
    const answers: Array<string | null> = [null, 'no_consent'];
    admin.rpc.mockImplementation(async () => ({ data: answers.length ? answers.shift() : null, error: null }));
    const gmail = fakeGmail({ address: ADDRESS, threads: [threadOf('big', 40)] });
    const inner = createGmailMailContentSource({ httpFor: async () => gmail.http, exclusion: NO_EXCLUSION });
    const reader = createGuardedContentSource(
      inner,
      { tenantId: gmail.source.tenantId, providerCheck: () => null, exclusion: NO_EXCLUSION },
      MAILBOX_PROVIDER.GOOGLE,
    );

    const pages: SourceItemPage[] = [];
    const run = async () => {
      for await (const page of reader.backfill(gmail.source, null)) pages.push(page);
    };
    await expect(run()).rejects.toBeInstanceOf(MailboxAccessRefusedError);
    expect(pages).toHaveLength(1);
    // Only page 1's requests were made: at most 25, and no raw fetch beyond what page 1 yielded.
    expect(gmail.log.length).toBeLessThanOrEqual(MAX_GMAIL_REQUESTS_PER_PAGE);
    expect(gmail.log.filter((l) => l.startsWith('raw:'))).toHaveLength(pages[0].items.length);
    expect(admin.rpc).toHaveBeenCalledTimes(2);
  });
});

describe('the Gmail factory demands the reader capability (C2)', () => {
  it('throws no_capability for a caller that does not hold it, before anything else', () => {
    for (const bogus of [undefined, null, {}, Object.create(null)]) {
      expect(() => getGoogleContentSource(bogus as never, SOURCE_KIND.MAILBOX, READER_MODE.LIVE, { exclusion: NO_EXCLUSION })).toThrow(
        expect.objectContaining({ name: 'MailboxAccessRefusedError', reason: 'no_capability' }),
      );
    }
  });
});

describe('the pass record counts under the page bound (#370)', () => {
  it('resets fetched at every 25-request flush: no page counts more raw reads than it made', async () => {
    const gmail = fakeGmail({ address: ADDRESS, threads: [threadOf('big', 40)] });
    const reader = createGmailMailContentSource({ httpFor: async () => gmail.http, exclusion: NO_EXCLUSION });
    const pages: SourceItemPage[] = [];
    const raws: number[] = [];
    let before = 0;
    for await (const page of reader.backfill(gmail.source, null)) {
      pages.push(page);
      const reads = gmail.log.filter((l) => l.startsWith('raw:')).length;
      raws.push(reads - before);
      before = reads;
    }
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.map((page) => page.fetched)).toEqual(raws);
    expect(pages.reduce((sum, page) => sum + (page.fetched ?? 0), 0)).toBe(40);
  });
});
