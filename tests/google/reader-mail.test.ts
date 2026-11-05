// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import {
  createGmailMailContentSource,
  eligibleHistoryIds,
  EXCLUDED_LABELS,
  MAX_GMAIL_REQUESTS_PER_PAGE,
  parseCheckpoint,
  serializeCheckpoint,
  THREADS_PER_CHUNK,
  type GmailCheckpoint,
} from '@/lib/google/reader/mail';
import type { ExclusionContext } from '@/lib/discovery/exclusion/types';
import type { DealContacts } from '@/lib/discovery/sendCensus/types';
import { GoogleHttpError } from '@/lib/google/reader/http';
import { MAX_RAW_BYTES, parseRaw, RawMessageTooLargeError } from '@/lib/google/reader/mime';
import { GMAIL_THREAD_METADATA_QUERY } from '@/lib/constants/googleReader';
import { CheckpointExpiredError } from '@/lib/discovery/source/checkpoint';
import type { SourceItemPage } from '@/lib/discovery/source/types';

import { addressRule, classificationRule, domainRule, exclusionWith, inThread, labelRule, markerRule, NO_EXCLUSION } from './exclusion';
import { fakeGmail, threadOf, type FakeHistoryRecord, type FakeThread } from './fakeGmail';

// A spy on the MIME parser at the module boundary: a message discarded after its fetch must never reach it (R10).
const parsed = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('@/lib/google/reader/mime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/google/reader/mime')>();
  return {
    ...actual,
    parseRaw: (raw: string) => {
      parsed.calls.push(raw);
      return actual.parseRaw(raw);
    },
  };
});

const ADDRESS = 'storm.duncan@bank.example';

async function drain(
  gmail: ReturnType<typeof fakeGmail>,
  options: { checkpoint?: string | null; exclusion?: ExclusionContext; dealContacts?: DealContacts; stopAfter?: number } = {},
): Promise<SourceItemPage[]> {
  const reader = createGmailMailContentSource({ httpFor: async () => gmail.http, exclusion: options.exclusion ?? NO_EXCLUSION, dealContacts: options.dealContacts });
  const pages: SourceItemPage[] = [];
  for await (const page of reader.backfill(gmail.source, options.checkpoint ?? null)) {
    pages.push(page);
    if (pages.length >= (options.stopAfter ?? Infinity)) break;
  }
  return pages;
}
const idsOf = (pages: SourceItemPage[]) => pages.flatMap((p) => p.items.map((m) => m.id));
const lastCheckpoint = (pages: SourceItemPage[]): GmailCheckpoint => parseCheckpoint(pages[pages.length - 1].nextCheckpoint);

describe('the send census fact (#425)', () => {
  it('classifies a later sent message from the whole thread, or as non-deal', async () => {
    const gmail = fakeGmail({ address: ADDRESS, threads: [{ id: 't', messages: [
      { id: 'first', labels: ['INBOX'], internalDate: 1000, to: [{ address: 'person@buyer.example' }] },
      { id: 'reply', labels: ['SENT'], internalDate: 2000 },
    ] }] });
    const contacts = { addresses: new Set(['person@buyer.example']), domains: [] };
    expect((await drain(gmail, { dealContacts: contacts })).flatMap((page) => page.items).find((item) => item.id === 'reply')?.send?.recipient).toBe('deal_contact');
    expect((await drain(gmail, { dealContacts: { addresses: new Set(), domains: [] } })).flatMap((page) => page.items).find((item) => item.id === 'reply')?.send?.recipient).toBe('non_deal');
  });

  it('classifies policy-excluded sends without fetching raw content', async () => {
    const gmail = fakeGmail({ address: ADDRESS, threads: [{ id: 't', messages: [
      { id: 'sent', labels: ['SENT'], internalDate: 2000, to: [{ address: 'person@buyer.example' }] },
    ] }] });
    const pages = await drain(gmail, {
      exclusion: exclusionWith([domainRule('buyer', 'buyer.example')], 1),
      dealContacts: { addresses: new Set(['person@buyer.example']), domains: [] },
    });
    expect(pages.flatMap((page) => page.skipped ?? [])[0].send?.recipient).toBe('deal_contact');
    expect(gmail.log).not.toContain('raw:sent');
  });
  it('carries SENT provider time but not an inbox or epoch time', async () => {
    const gmail = fakeGmail({ address: ADDRESS, threads: [{ id: 't', messages: [
      { id: 'sent', labels: ['SENT'], internalDate: 1700000000000 },
      { id: 'inbox', labels: ['INBOX'], internalDate: 1700000000001 },
      { id: 'epoch', labels: ['SENT'], internalDate: 0 },
      { id: 'missing', labels: ['SENT'] },
    ] }] });
    const items = (await drain(gmail)).flatMap((page) => page.items);
    expect(items.find((item) => item.id === 'sent')?.send).toEqual({ sentAt: '2023-11-14T22:13:20.000Z', recipient: null });
    for (const id of ['inbox', 'epoch', 'missing']) expect(items.find((item) => item.id === id)).not.toHaveProperty('send');
  });

  it('carries the fact through a metadata-only policy skip', async () => {
    const gmail = fakeGmail({ address: ADDRESS, threads: [{ id: 't', messages: [
      { id: 'sent', labels: ['SENT'], internalDate: 1700000000000, to: [{ address: 'outside@counsel.example' }] },
    ] }] });
    const pages = await drain(gmail, { exclusion: exclusionWith([domainRule('counsel', 'counsel.example')], 1) });
    expect(pages.flatMap((page) => page.skipped ?? [])[0].send).toEqual({ sentAt: '2023-11-14T22:13:20.000Z', recipient: null });
    expect(gmail.log).not.toContain('raw:sent');
  });
});

describe('the Gmail reader: request order and content', () => {
  const twoThreads: FakeThread[] = [
    { id: 't1', messages: [{ id: 'm1', internalDate: 1000 }, { id: 'm2', internalDate: 2000 }] },
    { id: 't2', messages: [{ id: 'm3', internalDate: 3000 }] },
  ];

  it('asks profile, list, then per thread threads.get and messages.get(raw), in that order', async () => {
    const gmail = fakeGmail({ address: ADDRESS, threads: twoThreads });
    const pages = await drain(gmail);
    expect(gmail.log).toEqual(['profile', 'list', 'thread:t1', 'raw:m1', 'raw:m2', 'thread:t2', 'raw:m3']);
    expect(idsOf(pages)).toEqual(['m1', 'm2', 'm3']);
  });

  it('yields the messages of a thread oldest first, whatever order Gmail listed them in', async () => {
    const gmail = fakeGmail({
      address: ADDRESS,
      threads: [{ id: 't1', messages: [{ id: 'late', internalDate: 3000 }, { id: 'early', internalDate: 1000 }, { id: 'mid', internalDate: 2000 }] }],
    });
    expect(idsOf(await drain(gmail))).toEqual(['early', 'mid', 'late']);
    expect(gmail.log.filter((l) => l.startsWith('raw:'))).toEqual(['raw:early', 'raw:mid', 'raw:late']);
  });

  it.each([...EXCLUDED_LABELS])('never fetches a %s message raw', async (label) => {
    const gmail = fakeGmail({
      address: ADDRESS,
      threads: [
        {
          id: 't1',
          messages: [
            { id: 'kept', internalDate: 1000 },
            { id: 'excluded', internalDate: 2000, labels: [label, 'INBOX'] },
          ],
        },
      ],
    });
    const pages = await drain(gmail);
    expect(idsOf(pages)).toEqual(['kept']);
    expect(gmail.log).not.toContain('raw:excluded');
    // format=raw was never requested for the excluded message.
    expect(gmail.log.filter((l) => l.startsWith('raw:'))).toEqual(['raw:kept']);
  });

  it('skips the raw fetch for a message the exclusion policy excludes, and ledgers it with its rule, version and thread', async () => {
    const gmail = fakeGmail({
      address: ADDRESS,
      threads: [
        {
          id: 't1',
          messages: [
            { id: 'a', internalDate: 1, to: [{ address: 'partner@counsel.example' }] },
            { id: 'b', internalDate: 2 },
          ],
        },
      ],
    });
    const pages = await drain(gmail, { exclusion: exclusionWith([domainRule('outside-counsel', 'counsel.example')], 3) });
    expect(idsOf(pages)).toEqual(['b']);
    expect(gmail.log).not.toContain('raw:a');
    expect(gmail.log.filter((l) => l.startsWith('raw:'))).toEqual(['raw:b']);
    const skipped = pages.flatMap((p) => p.skipped ?? []);
    expect(skipped).toEqual([
      {
        providerItemId: 'a',
        providerThreadId: 't1',
        itemHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        reason: 'policy_excluded',
        policy: { version: 3, ruleId: 'outside-counsel' },
      },
    ]);
  });

  it('maps From, To and Cc with their names, the Date header before internalDate, and prefers HTML to text', async () => {
    const gmail = fakeGmail({
      address: ADDRESS,
      threads: [
        {
          id: 't1',
          messages: [
            {
              id: 'm1',
              internalDate: Date.parse('2026-10-01T10:00:00Z'),
              date: '2026-09-30T08:00:00Z',
              from: { name: 'Storm Duncan', address: 'Storm.Duncan@bank.example' },
              to: [{ name: 'Morgan Vale', address: 'morgan.vale@bank.example' }, { address: 'alex.chen@bank.example' }],
              cc: [{ name: 'Casey', address: 'casey@heliotrope.example' }],
              subject: 'Project Falcon: next steps',
              body: { contentType: 'html', content: '<p>Falcon <b>update</b></p>' },
            },
            { id: 'm2', internalDate: Date.parse('2026-10-02T10:00:00Z'), body: { contentType: 'text', content: 'plain only' } },
          ],
        },
      ],
    });
    const [first, second] = (await drain(gmail))[0].items;
    expect(first).toMatchObject({
      id: 'm1',
      internetMessageId: '<m1@bank.example>',
      subject: 'Project Falcon: next steps',
      from: { emailAddress: { name: 'Storm Duncan', address: 'Storm.Duncan@bank.example' } },
      toRecipients: [
        { emailAddress: { name: 'Morgan Vale', address: 'morgan.vale@bank.example' } },
        { emailAddress: { address: 'alex.chen@bank.example' } },
      ],
      ccRecipients: [{ emailAddress: { name: 'Casey', address: 'casey@heliotrope.example' } }],
      hasAttachments: false,
    });
    expect(first.sentDateTime && Date.parse(first.sentDateTime)).toBe(Date.parse('2026-09-30T08:00:00Z'));
    expect(first.receivedDateTime).toBe('2026-10-01T10:00:00.000Z');
    expect(first.body.contentType).toBe('html');
    expect(first.body.content).toContain('<b>update</b>');
    expect(second.body).toMatchObject({ contentType: 'text' });
    expect(second.body.content).toContain('plain only');
    // The hash of the raw bytes is carried for #264; the worker ignores it.
    expect((first as { rawSha256?: string }).rawSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('falls back to internalDate when the Date header is missing or unreadable', async () => {
    const raw = Buffer.from('Message-ID: <nodate@bank.example>\r\nFrom: a@bank.example\r\nTo: b@bank.example\r\nSubject: s\r\n\r\nbody\r\n').toString('base64url');
    const gmail = fakeGmail({
      address: ADDRESS,
      threads: [{ id: 't1', messages: [{ id: 'm1', internalDate: Date.parse('2026-10-03T00:00:00Z'), raw }] }],
    });
    const [item] = (await drain(gmail))[0].items;
    expect(item.sentDateTime).toBe('2026-10-03T00:00:00.000Z');
  });

  it('drops a message with no Message-ID, like Graph does, and reads on', async () => {
    const raw = Buffer.from('From: a@bank.example\r\nTo: b@bank.example\r\nSubject: s\r\n\r\nbody\r\n').toString('base64url');
    const gmail = fakeGmail({
      address: ADDRESS,
      threads: [{ id: 't1', messages: [{ id: 'blank', internalDate: 1, raw }, { id: 'ok', internalDate: 2 }] }],
    });
    expect(idsOf(await drain(gmail))).toEqual(['ok']);
  });

  it('marks a message that carries an attachment, and keeps no attachment bytes', async () => {
    const mime = [
      'Message-ID: <att@bank.example>',
      'From: a@bank.example',
      'To: b@bank.example',
      'Subject: with a file',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="B"',
      '',
      '--B',
      'Content-Type: text/plain; charset=UTF-8',
      '',
      'see attached',
      '--B',
      'Content-Type: application/pdf; name="x.pdf"',
      'Content-Disposition: attachment; filename="x.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from('%PDF-secret').toString('base64'),
      '--B--',
      '',
    ].join('\r\n');
    const gmail = fakeGmail({
      address: ADDRESS,
      threads: [{ id: 't1', messages: [{ id: 'm1', internalDate: 1, raw: Buffer.from(mime).toString('base64url') }] }],
    });
    const [item] = (await drain(gmail))[0].items;
    expect(item.hasAttachments).toBe(true);
    expect(JSON.stringify(item)).not.toContain('PDF-secret');
    expect(item.body.content).toContain('see attached');
  });
});

describe('the Gmail reader: checkpoints', () => {
  it('carries {phase: delta, historyId: <the profile id>} on the final chunk', async () => {
    const gmail = fakeGmail({ address: ADDRESS, historyId: '4242', threads: [threadOf('t1', 2)] });
    const pages = await drain(gmail);
    expect(pages).toHaveLength(1);
    expect(lastCheckpoint(pages)).toMatchObject({ phase: 'delta', historyId: '4242', startHistoryId: '4242' });
  });

  it('takes the history id before the first listing (R21)', async () => {
    const gmail = fakeGmail({ address: ADDRESS, threads: [threadOf('t1', 1)] });
    await drain(gmail);
    expect(gmail.log.indexOf('profile')).toBe(0);
    expect(gmail.log.indexOf('profile')).toBeLessThan(gmail.log.indexOf('list'));
  });

  it('yields one empty page carrying it for an empty mailbox', async () => {
    const gmail = fakeGmail({ address: ADDRESS, historyId: '77', threads: [] });
    const pages = await drain(gmail);
    expect(pages).toHaveLength(1);
    expect(pages[0].items).toEqual([]);
    expect(lastCheckpoint(pages)).toMatchObject({ phase: 'delta', historyId: '77' });
  });

  it('makes a delta-phase checkpoint yield nothing, and ask for nothing (R21)', async () => {
    const gmail = fakeGmail({ address: ADDRESS, threads: [threadOf('t1', 3)] });
    const done = serializeCheckpoint({
      v: 1, kind: 'gmail-mail', phase: 'delta', startHistoryId: '1', pageToken: null, nextThreadId: null,
      nextMessageId: null, pageTokenRestarted: false, historyId: '1', historyPageToken: null,
    });
    expect(await drain(gmail, { checkpoint: done })).toEqual([]);
    expect(gmail.log).toEqual([]);
  });

  it('follows list pages, and yields a chunk after every ten threads even when every message was filtered', async () => {
    const threads: FakeThread[] = Array.from({ length: 25 }, (_, i) => ({
      id: `t${i + 1}`,
      messages: [{ id: `x${i + 1}`, internalDate: i, labels: ['SPAM'] }],
    }));
    const gmail = fakeGmail({ address: ADDRESS, threads, listPageSize: 12 });
    const pages = await drain(gmail);
    expect(idsOf(pages)).toEqual([]);
    // 25 threads over list pages of 12: a chunk after the tenth thread (page 1, next thread t11), one after
    // the twentieth (page 2, next thread t21, named by the token that fetched it), then the final chunk.
    expect(THREADS_PER_CHUNK).toBe(10);
    expect(pages.map((p) => parseCheckpoint(p.nextCheckpoint))).toMatchObject([
      { phase: 'backfill', pageToken: null, nextThreadId: 't11', nextMessageId: null },
      { phase: 'backfill', pageToken: 'p1', nextThreadId: 't21', nextMessageId: null },
      { phase: 'delta', historyId: '1000' },
    ]);
    expect(gmail.log.filter((l) => l.startsWith('list'))).toEqual(['list', 'list:p1', 'list:p2']);
    expect(gmail.log.filter((l) => l.startsWith('raw'))).toEqual([]);
    expect(lastCheckpoint(pages).phase).toBe('delta');
  });

  it('rejects a checkpoint it cannot read', () => {
    for (const bad of ['', 'not json', '{}', JSON.stringify({ v: 2 }), JSON.stringify({ v: 1, kind: 'graph-delta' })]) {
      expect(() => parseCheckpoint(bad), bad).toThrow('gmail reader: unreadable checkpoint');
    }
    const ok = serializeCheckpoint(parseCheckpoint(null));
    expect(parseCheckpoint(ok)).toMatchObject({ phase: 'backfill', pageToken: null, nextThreadId: null, nextMessageId: null });
  });
});

describe('parseRaw', () => {
  it('refuses a raw message over the size bound with a typed error the reader skips', async () => {
    const big = Buffer.alloc(MAX_RAW_BYTES + 1, 0x61).toString('base64url');
    await expect(parseRaw(big)).rejects.toBeInstanceOf(RawMessageTooLargeError);
  });

  it('skips an oversized message and reads on', async () => {
    const big = Buffer.alloc(MAX_RAW_BYTES + 1, 0x61).toString('base64url');
    const gmail = fakeGmail({
      address: ADDRESS,
      threads: [{ id: 't1', messages: [{ id: 'huge', internalDate: 1, raw: big }, { id: 'ok', internalDate: 2 }] }],
    });
    expect(idsOf(await drain(gmail))).toEqual(['ok']);
  });
});

// ── Resume, stale tokens and the incremental history pass (#259 phase 3) ─────

const checkpointOf = (over: Partial<GmailCheckpoint>): string =>
  serializeCheckpoint({ ...parseCheckpoint(null), startHistoryId: '1000', ...over });
const deltaAt = (historyId: string, over: Partial<GmailCheckpoint> = {}): string =>
  checkpointOf({ phase: 'delta', historyId, ...over });

async function drainDelta(
  gmail: ReturnType<typeof fakeGmail>,
  checkpoint: string,
  options: { exclusion?: ExclusionContext; dealContacts?: DealContacts; onPage?: (page: SourceItemPage, requestsSoFar: number) => void } = {},
): Promise<SourceItemPage[]> {
  const reader = createGmailMailContentSource({ httpFor: async () => gmail.http, exclusion: options.exclusion ?? NO_EXCLUSION, dealContacts: options.dealContacts });
  const pages: SourceItemPage[] = [];
  for await (const page of reader.delta(gmail.source, checkpoint)) {
    pages.push(page);
    options.onPage?.(page, gmail.log.length);
  }
  return pages;
}

const added = (id: string, ...ids: string[]): FakeHistoryRecord => ({
  id,
  messagesAdded: ids.map((m) => ({ message: { id: m } })),
});

it('carries a SENT fact from history messagesAdded on delta', async () => {
  const gmail = fakeGmail({ address: ADDRESS, threads: [{ id: 't', messages: [{ id: 'sent', labels: ['SENT'], internalDate: 1700000000000 }] }], history: { pages: [[added('1001', 'sent')]], validStart: '1000' } });
  const pages = await drainDelta(gmail, deltaAt('1000'));
  expect(pages.flatMap((page) => page.items)[0].send).toEqual({ sentAt: '2023-11-14T22:13:20.000Z', recipient: null });
});

it('classifies a delta sent message from another message on its thread', async () => {
  const gmail = fakeGmail({ address: ADDRESS, threads: [{ id: 't', messages: [
    { id: 'older', labels: ['INBOX'], internalDate: 1000, to: [{ address: 'person@buyer.example' }] },
    { id: 'sent', labels: ['SENT'], internalDate: 2000 },
  ] }], history: { pages: [[added('1001', 'sent')]], validStart: '1000' } });
  const pages = await drainDelta(gmail, deltaAt('1000'), { dealContacts: { addresses: new Set(['person@buyer.example']), domains: [] } });
  expect(pages.flatMap((page) => page.items)[0].send?.recipient).toBe('deal_contact');
});

describe('the Gmail reader: resuming a backfill', () => {
  const threads: FakeThread[] = [
    { id: 't1', messages: [{ id: 't1-m1', internalDate: 1 }, { id: 't1-m2', internalDate: 2 }] },
    { id: 't2', messages: [{ id: 't2-m1', internalDate: 3 }, { id: 't2-m2', internalDate: 4 }, { id: 't2-m3', internalDate: 5 }] },
    { id: 't3', messages: [{ id: 't3-m1', internalDate: 6 }] },
  ];

  it('re-reads nothing already yielded: it resumes at the thread and message the checkpoint names', async () => {
    const gmail = fakeGmail({ address: ADDRESS, threads, listPageSize: 2 });
    const pages = await drain(gmail, { checkpoint: checkpointOf({ pageToken: null, nextThreadId: 't2', nextMessageId: 't2-m2' }) });
    // No profile (the start id is in the checkpoint), and only what follows t2's first message.
    expect(gmail.log).toEqual(['list', 'thread:t2', 'raw:t2-m2', 'raw:t2-m3', 'list:p1', 'thread:t3', 'raw:t3-m1']);
    expect(idsOf(pages)).toEqual(['t2-m2', 't2-m3', 't3-m1']);
    // The message offset applies to the first thread only.
    expect(lastCheckpoint(pages)).toMatchObject({ phase: 'delta', historyId: '1000' });
  });

  it('resumes from a later list page by its token', async () => {
    const gmail = fakeGmail({ address: ADDRESS, threads, listPageSize: 2 });
    const pages = await drain(gmail, { checkpoint: checkpointOf({ pageToken: 'p1', nextThreadId: null, nextMessageId: null }) });
    expect(gmail.log).toEqual(['list:p1', 'thread:t3', 'raw:t3-m1']);
    expect(idsOf(pages)).toEqual(['t3-m1']);
  });

  it('still resumes a checkpoint stored before ids, by its numeric thread and message offsets', async () => {
    const gmail = fakeGmail({ address: ADDRESS, threads, listPageSize: 2 });
    // The shape the first release wrote: offsets, and no nextThreadId or nextMessageId at all.
    const legacy = JSON.stringify({
      v: 1, kind: 'gmail-mail', phase: 'backfill', startHistoryId: '1000', pageToken: null,
      threadOffset: 1, messageOffset: 1, pageTokenRestarted: false, historyId: null, historyPageToken: null,
    });
    const pages = await drain(gmail, { checkpoint: legacy });
    expect(gmail.log).toEqual(['list', 'thread:t2', 'raw:t2-m2', 'raw:t2-m3', 'list:p1', 'thread:t3', 'raw:t3-m1']);
    expect(idsOf(pages)).toEqual(['t2-m2', 't2-m3', 't3-m1']);
    // What it writes is by id, and the offsets are not carried on.
    expect(lastCheckpoint(pages)).toMatchObject({ phase: 'delta', historyId: '1000' });
  });

  it('does not skip the next unread thread when an earlier thread was deleted before the resume', async () => {
    const many: FakeThread[] = Array.from({ length: 14 }, (_, i) => threadOf(`t${i + 1}`, 1));
    const before = fakeGmail({ address: ADDRESS, threads: many });
    const run1 = await drain(before, { stopAfter: 1 });
    expect(idsOf(run1)).toHaveLength(THREADS_PER_CHUNK);

    // t1 (already read) is deleted: every later thread moves up one place in the listing.
    const after = fakeGmail({ address: ADDRESS, threads: many.slice(1) });
    const run2 = await drain(after, { checkpoint: run1[0].nextCheckpoint });
    expect(idsOf(run2)).toEqual(['t11-m1', 't12-m1', 't13-m1', 't14-m1']);
    expect(after.log).not.toContain('profile');
    expect(parseCheckpoint(run1[0].nextCheckpoint)).toMatchObject({ nextThreadId: 't11', nextMessageId: null });
  });

  it('does not skip the next unread message when an earlier message of the thread was deleted before the resume', async () => {
    const big = threadOf('big', 40);
    const before = fakeGmail({ address: ADDRESS, threads: [big] });
    const run1 = await drain(before, { stopAfter: 1 });
    const read = idsOf(run1);
    expect(read.length).toBeGreaterThan(0);
    expect(read.length).toBeLessThan(40);

    // The first message (already read) is deleted: the rest move up one place in the thread.
    const after = fakeGmail({ address: ADDRESS, threads: [{ id: 'big', messages: big.messages.slice(1) }] });
    const run2 = await drain(after, { checkpoint: run1[0].nextCheckpoint });
    expect(idsOf(run2)).toEqual(Array.from({ length: 40 - read.length }, (_, i) => `big-m${read.length + 1 + i}`));
    expect(after.log.filter((l) => l.startsWith('raw:'))).toHaveLength(40 - read.length);
    expect(parseCheckpoint(run1[0].nextCheckpoint)).toMatchObject({ nextThreadId: 'big', nextMessageId: `big-m${read.length + 1}` });
  });

  it('restarts the listing page from its first thread when the named thread is gone', async () => {
    const gmail = fakeGmail({ address: ADDRESS, threads, listPageSize: 2 });
    // t2 is named, but the listing no longer holds it: the page is read again from the top, the ledger absorbs the repeats.
    const pages = await drain(gmail, { checkpoint: checkpointOf({ pageToken: null, nextThreadId: 'deleted-thread', nextMessageId: 'x' }) });
    expect(gmail.log).toEqual(['list', 'thread:t1', 'raw:t1-m1', 'raw:t1-m2', 'thread:t2', 'raw:t2-m1', 'raw:t2-m2', 'raw:t2-m3', 'list:p1', 'thread:t3', 'raw:t3-m1']);
    expect(idsOf(pages)).toEqual(['t1-m1', 't1-m2', 't2-m1', 't2-m2', 't2-m3', 't3-m1']);
  });

  it('restarts the thread from its first message when the named message is gone', async () => {
    const gmail = fakeGmail({ address: ADDRESS, threads, listPageSize: 2 });
    const pages = await drain(gmail, { checkpoint: checkpointOf({ pageToken: null, nextThreadId: 't2', nextMessageId: 'deleted-message' }) });
    // t1 is passed over (the checkpoint names t2); t2 is read whole; the message id applies to that thread only.
    expect(gmail.log).toEqual(['list', 'thread:t2', 'raw:t2-m1', 'raw:t2-m2', 'raw:t2-m3', 'list:p1', 'thread:t3', 'raw:t3-m1']);
    expect(idsOf(pages)).toEqual(['t2-m1', 't2-m2', 't2-m3', 't3-m1']);
  });

  it('keeps the page bound and yields a by-id checkpoint from every mid-thread page after a resume', async () => {
    const big = threadOf('big', 60);
    const before = fakeGmail({ address: ADDRESS, threads: [big] });
    const run1 = await drain(before, { stopAfter: 1 });
    const after = fakeGmail({ address: ADDRESS, threads: [{ id: 'big', messages: big.messages.slice(1) }] });
    let last = 0;
    const spans: number[] = [];
    const reader = createGmailMailContentSource({ httpFor: async () => after.http, exclusion: NO_EXCLUSION });
    const pages: SourceItemPage[] = [];
    for await (const page of reader.backfill(after.source, run1[0].nextCheckpoint)) {
      pages.push(page);
      spans.push(after.log.length - last);
      last = after.log.length;
    }
    expect(Math.max(...spans)).toBeLessThanOrEqual(MAX_GMAIL_REQUESTS_PER_PAGE);
    expect(pages.length).toBeGreaterThan(1);
    const mid = parseCheckpoint(pages[0].nextCheckpoint);
    expect(mid).toMatchObject({ phase: 'backfill', nextThreadId: 'big' });
    expect(mid.nextMessageId).toBe(`big-m${idsOf(run1).length + 1 + pages[0].items.length}`);
  });
});

describe('the Gmail reader: a stale page token (R21)', () => {
  const threads: FakeThread[] = [threadOf('t1', 1), threadOf('t2', 1), threadOf('t3', 1)];

  it('restarts the listing from the top once, keeping the start id, and reads on', async () => {
    let refused = false;
    const gmail = fakeGmail({
      address: ADDRESS,
      threads,
      listPageSize: 2,
      inject: ({ path, url }) => {
        if (path !== '/threads' || url.searchParams.get('pageToken') !== 'p1' || refused) return undefined;
        refused = true;
        return { status: 400 };
      },
    });
    const pages = await drain(gmail, { checkpoint: checkpointOf({ pageToken: 'p1' }) });
    // The stale token, then the top of the listing, then p1 again (now honoured).
    expect(gmail.log.filter((l) => l.startsWith('list'))).toEqual(['list:p1', 'list', 'list:p1']);
    expect(gmail.log).not.toContain('profile');
    expect(idsOf(pages)).toEqual(['t1-m1', 't2-m1', 't3-m1']);
    // The restart is spent for this pass, and the delta checkpoint starts clean.
    expect(pages.map((p) => parseCheckpoint(p.nextCheckpoint).pageTokenRestarted)).toEqual([false]);
    expect(lastCheckpoint(pages)).toMatchObject({ phase: 'delta', historyId: '1000', startHistoryId: '1000' });
  });

  it('carries the restart in the checkpoint, so a second stale token in the same pass throws', async () => {
    const gmail = fakeGmail({
      address: ADDRESS,
      threads,
      listPageSize: 2,
      inject: ({ path, url }) => (path === '/threads' && url.searchParams.get('pageToken') === 'p1' ? { status: 400 } : undefined),
    });
    const error = await drain(gmail, { checkpoint: checkpointOf({ pageToken: 'p1' }) }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GoogleHttpError);
    expect(error).toMatchObject({ status: 400 });
    // One restart, then the second 400 is the error: the listing does not loop.
    expect(gmail.log.filter((l) => l === 'list:p1')).toHaveLength(2);

    const spent = fakeGmail({
      address: ADDRESS,
      threads,
      listPageSize: 2,
      inject: ({ path }) => (path === '/threads' ? { status: 400 } : undefined),
    });
    await expect(drain(spent, { checkpoint: checkpointOf({ pageToken: 'p1', pageTokenRestarted: true }) })).rejects.toMatchObject({ status: 400 });
    expect(spent.log).toEqual(['list:p1']);
  });

  it('rethrows a 400 that did not carry a page token', async () => {
    const gmail = fakeGmail({ address: ADDRESS, threads, inject: ({ path }) => (path === '/threads' ? { status: 400 } : undefined) });
    await expect(drain(gmail)).rejects.toMatchObject({ status: 400 });
    expect(gmail.log.filter((l) => l.startsWith('list'))).toEqual(['list']);
  });
});

describe('the Gmail reader: the incremental history pass', () => {
  it('reads what history.list names, from the stored id, and moves the checkpoint to the response id', async () => {
    const gmail = fakeGmail({
      address: ADDRESS,
      threads: [{ id: 't1', messages: [{ id: 'new1', internalDate: 10 }, { id: 'new2', internalDate: 20 }] }],
      history: { pages: [[added('1001', 'new1'), added('1002', 'new2')]], current: '1002', validStart: '1000' },
    });
    const pages = await drainDelta(gmail, deltaAt('1000'));
    // One threads.get names both messages of the conversation; neither is asked for singly.
    expect(gmail.log).toEqual(['history:1000', 'thread:t1', 'raw:new1', 'raw:new2']);
    expect(idsOf(pages)).toEqual(['new1', 'new2']);
    expect(lastCheckpoint(pages)).toMatchObject({ phase: 'delta', historyId: '1002', historyPageToken: null, startHistoryId: '1000' });
  });

  it('yields one empty page carrying the response id when nothing changed', async () => {
    const gmail = fakeGmail({ address: ADDRESS, threads: [], history: { pages: [], current: '1000', validStart: '1000' } });
    const pages = await drainDelta(gmail, deltaAt('1000'));
    expect(pages).toHaveLength(1);
    expect(pages[0].items).toEqual([]);
    expect(lastCheckpoint(pages)).toMatchObject({ phase: 'delta', historyId: '1000', historyPageToken: null });
  });

  it('asks for the message-added and label-removed records, 100 to a page', async () => {
    const urls: string[] = [];
    const gmail = fakeGmail({
      address: ADDRESS,
      threads: [],
      history: { pages: [] },
      inject: ({ path, url }) => {
        if (path === '/history') urls.push(url.search);
        return undefined;
      },
    });
    await drainDelta(gmail, deltaAt('1000'));
    const query = new URLSearchParams(urls[0]);
    expect(query.getAll('historyTypes')).toEqual(['messageAdded', 'labelRemoved']);
    expect(query.get('maxResults')).toBe('100');
    expect(query.get('startHistoryId')).toBe('1000');
  });

  it('keeps the start id until the final history page, then moves to the response id', async () => {
    const gmail = fakeGmail({
      address: ADDRESS,
      threads: [{ id: 't1', messages: [{ id: 'a', internalDate: 1 }, { id: 'b', internalDate: 2 }, { id: 'c', internalDate: 3 }] }],
      history: { pages: [[added('1001', 'a')], [added('1002', 'b')], [added('1003', 'c')]], current: '1003', validStart: '1000' },
    });
    const pages = await drainDelta(gmail, deltaAt('1000'));
    expect(idsOf(pages)).toEqual(['a', 'b', 'c']);
    expect(pages.map((p) => parseCheckpoint(p.nextCheckpoint))).toMatchObject([
      { historyId: '1000', historyPageToken: 'h1' },
      { historyId: '1000', historyPageToken: 'h2' },
      { historyId: '1003', historyPageToken: null },
    ]);
    // Every history page was asked for from the pass's start id.
    expect(gmail.log.filter((l) => l.startsWith('history:'))).toEqual(['history:1000', 'history:1000:h1', 'history:1000:h2']);
  });

  it('resumes at the history page the checkpoint names, and reads nothing before it', async () => {
    const gmail = fakeGmail({
      address: ADDRESS,
      threads: [{ id: 't1', messages: [{ id: 'a', internalDate: 1 }, { id: 'b', internalDate: 2 }] }],
      history: { pages: [[added('1001', 'a')], [added('1002', 'b')]], current: '1002', validStart: '1000' },
    });
    const pages = await drainDelta(gmail, deltaAt('1000', { historyPageToken: 'h1' }));
    expect(gmail.log).toEqual(['history:1000:h1', 'thread:t1', 'raw:b']);
    expect(idsOf(pages)).toEqual(['b']);
  });

  it('reads a message that left SPAM like a new one, and ignores every other label change', async () => {
    const gmail = fakeGmail({
      address: ADDRESS,
      threads: [
        {
          id: 't1',
          messages: [
            { id: 'unspammed', internalDate: 1 },
            { id: 'untrashed', internalDate: 2 },
            { id: 'starred', internalDate: 3 },
          ],
        },
      ],
      history: {
        pages: [
          [
            { id: '1001', labelsRemoved: [{ message: { id: 'unspammed' }, labelIds: ['SPAM'] }] },
            { id: '1002', labelsRemoved: [{ message: { id: 'untrashed' }, labelIds: ['TRASH'] }] },
            { id: '1003', labelsRemoved: [{ message: { id: 'starred' }, labelIds: ['STARRED', 'UNREAD'] }] },
          ],
        ],
        current: '1003',
        validStart: '1000',
      },
    });
    const pages = await drainDelta(gmail, deltaAt('1000'));
    expect(idsOf(pages)).toEqual(['unspammed', 'untrashed']);
    // The starred message is in the thread's metadata, but no record made it readable: never fetched raw.
    expect(gmail.log).toEqual(['history:1000', 'thread:t1', 'raw:unspammed', 'raw:untrashed']);
  });

  it('never fetches a message raw that still carries an excluded label, and skips one the policy excludes', async () => {
    const gmail = fakeGmail({
      address: ADDRESS,
      threads: [
        {
          id: 't1',
          messages: [
            { id: 'ok', internalDate: 1 },
            { id: 'spam', internalDate: 2, labels: ['SPAM'] },
            { id: 'draft', internalDate: 3, labels: ['DRAFT'] },
            { id: 'skipme', internalDate: 4, headers: { Sensitivity: 'Private' } },
          ],
        },
      ],
      history: { pages: [[added('1001', 'ok', 'spam', 'draft', 'skipme')]], current: '1001', validStart: '1000' },
    });
    const pages = await drainDelta(gmail, deltaAt('1000'), { exclusion: exclusionWith([markerRule('private', 'sensitivity', 'private')]) });
    expect(idsOf(pages)).toEqual(['ok']);
    expect(gmail.log.filter((l) => l.startsWith('raw:'))).toEqual(['raw:ok']);
    expect(pages.flatMap((p) => p.skipped ?? []).map((s) => [s.providerItemId, s.reason])).toEqual([['skipme', 'policy_excluded']]);
  });

  it('reads a page oldest first, whatever order its records name the messages in', async () => {
    const gmail = fakeGmail({
      address: ADDRESS,
      threads: [{ id: 't1', messages: [{ id: 'late', internalDate: 300 }, { id: 'early', internalDate: 100 }, { id: 'mid', internalDate: 200 }] }],
      history: { pages: [[added('1001', 'late'), added('1002', 'early'), added('1003', 'mid')]], current: '1003', validStart: '1000' },
    });
    const pages = await drainDelta(gmail, deltaAt('1000'));
    expect(idsOf(pages)).toEqual(['early', 'mid', 'late']);
  });

  it('reads a message named more than once in a pass once', async () => {
    const gmail = fakeGmail({
      address: ADDRESS,
      threads: [{ id: 't1', messages: [{ id: 'twice', internalDate: 1 }] }],
      history: {
        pages: [
          [added('1001', 'twice'), { id: '1002', labelsRemoved: [{ message: { id: 'twice' }, labelIds: ['SPAM'] }] }, added('1003', 'twice')],
          [added('1004', 'twice')],
        ],
        current: '1004',
        validStart: '1000',
      },
    });
    const pages = await drainDelta(gmail, deltaAt('1000'));
    expect(idsOf(pages)).toEqual(['twice']);
    expect(gmail.log.filter((l) => l === 'raw:twice')).toHaveLength(1);
    // Named on two pages: its conversation is read for the first, and nothing is left to ask for on the second.
    expect(gmail.log.filter((l) => l === 'thread:t1')).toHaveLength(1);
  });

  it('skips a message deleted since it was named, whether its thread or its raw is gone', async () => {
    const gmail = fakeGmail({
      address: ADDRESS,
      threads: [{ id: 't1', messages: [{ id: 'kept', internalDate: 3 }, { id: 'goneRaw', internalDate: 2 }] }],
      history: {
        pages: [
          [
            { id: '1001', messagesAdded: [{ message: { id: 'goneThread', threadId: 'vanished' } }] },
            added('1002', 'goneRaw', 'kept'),
          ],
        ],
        current: '1002',
        validStart: '1000',
      },
      inject: ({ path, url }) =>
        path === '/messages/goneRaw' && url.searchParams.get('format') === 'raw' ? { status: 404 } : undefined,
    });
    const pages = await drainDelta(gmail, deltaAt('1000'));
    expect(idsOf(pages)).toEqual(['kept']);
    // The vanished thread is no item, no skip and no taint, and it does not hold the pass back.
    expect(pages.flatMap((p) => [...(p.skipped ?? []), ...(p.threadTaints ?? [])])).toEqual([]);
    expect(gmail.log).toEqual(['history:1000', 'thread:vanished', 'thread:t1', 'raw:goneRaw', 'raw:kept']);
    expect(lastCheckpoint(pages)).toMatchObject({ historyId: '1002' });
  });

  it('throws CheckpointExpiredError when Gmail no longer holds the start id (404)', async () => {
    const gmail = fakeGmail({ address: ADDRESS, threads: [], history: { pages: [], validStart: '5000' } });
    const error = await drainDelta(gmail, deltaAt('1')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CheckpointExpiredError);
    expect(error).toMatchObject({ provider: 'google', name: 'CheckpointExpiredError' });
    expect(gmail.log).toEqual(['history:1']);
  });

  it('restarts from the start id when a stored historyPageToken is stale (400), once', async () => {
    let refused = false;
    const gmail = fakeGmail({
      address: ADDRESS,
      threads: [{ id: 't1', messages: [{ id: 'a', internalDate: 1 }, { id: 'b', internalDate: 2 }] }],
      history: { pages: [[added('1001', 'a')], [added('1002', 'b')]], current: '1002', validStart: '1000' },
      inject: ({ path, url }) => {
        if (path !== '/history' || url.searchParams.get('pageToken') !== 'h1' || refused) return undefined;
        refused = true;
        return { status: 400 };
      },
    });
    const pages = await drainDelta(gmail, deltaAt('1000', { historyPageToken: 'h1' }));
    expect(gmail.log.filter((l) => l.startsWith('history:'))).toEqual(['history:1000:h1', 'history:1000', 'history:1000:h1']);
    expect(idsOf(pages)).toEqual(['a', 'b']);
    expect(lastCheckpoint(pages)).toMatchObject({ historyId: '1002', pageTokenRestarted: false });

    const always = fakeGmail({
      address: ADDRESS,
      threads: [],
      history: { pages: [] },
      inject: ({ path, url }) => (path === '/history' && url.searchParams.get('pageToken') ? { status: 400 } : undefined),
    });
    await expect(drainDelta(always, deltaAt('1000', { historyPageToken: 'h1', pageTokenRestarted: true }))).rejects.toMatchObject({ status: 400 });
    expect(always.log).toEqual(['history:1000:h1']);
  });

  it('rethrows any other history error, and a 400 without a page token', async () => {
    for (const status of [400, 403, 500]) {
      const gmail = fakeGmail({ address: ADDRESS, threads: [], inject: ({ path }) => (path === '/history' ? { status } : undefined) });
      await expect(drainDelta(gmail, deltaAt('1000')), String(status)).rejects.toMatchObject({ status });
    }
  });

  it('refuses a checkpoint that is not a delta checkpoint, as an unreadable one', async () => {
    const gmail = fakeGmail({ address: ADDRESS, threads: [] });
    await expect(drainDelta(gmail, checkpointOf({ phase: 'backfill' }))).rejects.toThrow('gmail reader: unreadable checkpoint');
    await expect(drainDelta(gmail, 'not json')).rejects.toThrow('gmail reader: unreadable checkpoint');
    expect(gmail.log).toEqual([]);
  });

  it('never asks Gmail more than the page bound between two yields, and a yield mid-page names the page it is in', async () => {
    const messages = Array.from({ length: 60 }, (_, i) => ({ id: `n${i + 1}`, internalDate: i + 1 }));
    const gmail = fakeGmail({
      address: ADDRESS,
      threads: [{ id: 't1', messages }],
      history: { pages: [[added('1001', ...messages.map((m) => m.id))]], current: '1001', validStart: '1000' },
    });
    let last = 0;
    const spans: number[] = [];
    const pages = await drainDelta(gmail, deltaAt('1000'), {
      onPage: (_page, requests) => {
        spans.push(requests - last);
        last = requests;
      },
    });
    expect(Math.max(...spans)).toBeLessThanOrEqual(MAX_GMAIL_REQUESTS_PER_PAGE);
    expect(spans.length).toBeGreaterThan(2);
    // 1 history + 1 thread + 60 raw requests were made in all, none twice.
    expect(gmail.log).toHaveLength(62);
    expect(idsOf(pages)).toEqual(messages.map((m) => m.id));
    // Yields before the last still point at the pass's first history page and start id.
    for (const page of pages.slice(0, -1)) {
      expect(parseCheckpoint(page.nextCheckpoint)).toMatchObject({ phase: 'delta', historyId: '1000', historyPageToken: null });
    }
    expect(lastCheckpoint(pages)).toMatchObject({ historyId: '1001' });
  });
});

describe('eligibleHistoryIds', () => {
  it('names added messages and messages that left SPAM or TRASH, once each, in record order', () => {
    expect(
      eligibleHistoryIds({
        history: [
          { messagesAdded: [{ message: { id: 'a' } }, { message: { id: 'b' } }] },
          { labelsRemoved: [{ message: { id: 'b' }, labelIds: ['SPAM'] }, { message: { id: 'c' }, labelIds: ['INBOX'] }] },
          { labelsRemoved: [{ message: { id: 'd' }, labelIds: ['TRASH', 'STARRED'] }] },
          {},
        ],
      }),
    ).toEqual(['a', 'b', 'd']);
    expect(eligibleHistoryIds({})).toEqual([]);
  });
});

describe('the Gmail reader: the two-step read and its queries (#263)', () => {
  const USER = 'storm.duncan%40bank.example';
  const HEADERS =
    'metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Bcc&metadataHeaders=Reply-To&metadataHeaders=Sender' +
    '&metadataHeaders=Message-ID' +
    '&metadataHeaders=Sensitivity&metadataHeaders=msip_labels';
  const MESSAGE_FIELDS = 'id,threadId,labelIds,internalDate,historyId,payload/headers,classificationLabelValues';
  const base = `https://gmail.googleapis.com/gmail/v1/users/${USER}`;

  it('asks for its listings and metadata under fields masks, with the marker headers, and for raw with none', async () => {
    const gmail = fakeGmail({
      address: ADDRESS,
      threads: [{ id: 't1', messages: [{ id: 'm1', internalDate: 1 }] }],
      history: { pages: [[added('1001', 'm1')]], current: '1001', validStart: '1000' },
    });
    await drain(gmail);
    expect(gmail.urls).toEqual([
      `${base}/profile`,
      `${base}/threads?maxResults=100&includeSpamTrash=false&fields=threads(id,historyId),nextPageToken`,
      `${base}/threads/t1?format=metadata&${HEADERS}&fields=id,historyId,messages(${MESSAGE_FIELDS})`,
      `${base}/messages/m1?format=raw`,
    ]);
    const delta = fakeGmail({
      address: ADDRESS,
      threads: [{ id: 't1', messages: [{ id: 'm1', internalDate: 1 }] }],
      history: { pages: [[added('1001', 'm1')]], current: '1001', validStart: '1000' },
    });
    await drainDelta(delta, deltaAt('1000'));
    expect(delta.urls).toEqual([
      `${base}/history?historyTypes=messageAdded&historyTypes=labelRemoved&maxResults=100&startHistoryId=1000` +
        '&fields=history(id,messagesAdded/message(id,threadId,labelIds),labelsRemoved(message(id,threadId,labelIds),labelIds)),historyId,nextPageToken',
      `${base}/threads/t1?format=metadata&${HEADERS}&fields=id,historyId,messages(${MESSAGE_FIELDS})`,
      `${base}/messages/m1?format=raw`,
    ]);
  });

  it('never asks for a snippet before the verdict: no masked request mentions one', async () => {
    const gmail = fakeGmail({
      address: ADDRESS,
      threads: [{ id: 't1', messages: [{ id: 'm1', internalDate: 1 }] }],
      history: { pages: [[added('1001', 'm1')]], current: '1001', validStart: '1000' },
    });
    await drain(gmail);
    await drainDelta(gmail, deltaAt('1000'));
    // Every call but the raw fetch carries a mask that names no snippet, and the fake refuses an unmasked one.
    for (const url of gmail.urls.filter((u) => !u.includes('format=raw') && !u.endsWith('/profile'))) {
      expect(url).toContain('fields=');
      expect(url).not.toContain('snippet');
    }
  });

  it('never asks for the Subject, a date or a threading header before the verdict (#337)', async () => {
    const gmail = fakeGmail({
      address: ADDRESS,
      threads: [{ id: 't1', messages: [{ id: 'm1', internalDate: 1 }] }],
      history: { pages: [[added('1001', 'm1')]], current: '1001', validStart: '1000' },
    });
    await drain(gmail);
    await drainDelta(gmail, deltaAt('1000'));
    const metadata = gmail.urls.filter((u) => u.includes('format=metadata'));
    expect(metadata.length).toBeGreaterThan(0);
    for (const url of metadata) expect(url).not.toMatch(/metadataHeaders=(Subject|Date|In-Reply-To|References)(&|$)/i);
  });

  it("gets no Subject back for the reader's own thread query, though the message has one (#337)", async () => {
    const gmail = fakeGmail({ address: ADDRESS, threads: [{ id: 't1', messages: [{ id: 'm1', internalDate: 1, subject: 'Project Falcon SECRETSUBJECT' }] }] });
    const response = await gmail.fetchImpl(`${base}/threads/t1?${GMAIL_THREAD_METADATA_QUERY}`);
    const body = (await response.json()) as { messages: Array<{ payload: { headers: Array<{ name: string }> } }> };
    expect(body.messages[0].payload.headers.map((h) => h.name)).toEqual(['From', 'To', 'Message-ID']);
    expect(JSON.stringify(body)).not.toContain('SECRETSUBJECT');
  });

  it('ledgers an excluded message with a hash of its metadata and no content, and never fetches it raw', async () => {
    const gmail = fakeGmail({
      address: ADDRESS,
      threads: [
        {
          id: 't1',
          messages: [
            { id: 'hr', internalDate: 5, messageId: '<HR-1@bank.example>', to: [{ address: 'HR-Alias@bank.example' }], subject: 'Compensation review' },
            { id: 'ok', internalDate: 6 },
          ],
        },
      ],
    });
    const pages = await drain(gmail, { exclusion: exclusionWith([addressRule('hr-alias', 'hr-alias@bank.example')]) });
    const [skipped] = pages.flatMap((p) => p.skipped ?? []);
    // sha256("gmail-message\n" + id + "\n" + internalDate + "\n" + lower(Message-ID)): no subject in it.
    const { createHash } = await import('node:crypto');
    expect(skipped.itemHash).toBe(createHash('sha256').update('gmail-message\nhr\n5\n<hr-1@bank.example>').digest('hex'));
    expect(JSON.stringify(skipped)).not.toContain('Compensation');
    expect(gmail.log).not.toContain('raw:hr');
    expect(idsOf(pages)).toEqual(['ok']);
  });

  it('takes the thread id from the listing, or from the history record, when a metadata message has none, and fails closed on a history record with none', async () => {
    const noThreadId = (id: string) => ({
      id,
      labelIds: ['INBOX'],
      internalDate: '1',
      payload: { headers: [{ name: 'From', value: 'a@counsel.example' }, { name: 'Message-ID', value: `<${id}@x.example>` }] },
    });
    const listed = fakeGmail({
      address: ADDRESS,
      threads: [{ id: 't1', messages: [{ id: 'm1', internalDate: 1 }] }],
      inject: ({ path }) => (path === '/threads/t1' ? { status: 200, body: { id: 't1', messages: [noThreadId('m1')] } } : undefined),
    });
    const pages = await drain(listed, { exclusion: exclusionWith([domainRule('counsel', 'counsel.example')]) });
    expect(pages.flatMap((p) => p.skipped ?? [])).toMatchObject([{ providerItemId: 'm1', providerThreadId: 't1' }]);

    // The incremental pass takes it from the history record when the thread's metadata has none.
    const viaHistory = fakeGmail({
      address: ADDRESS,
      threads: [{ id: 't1', messages: [{ id: 'm1', internalDate: 1 }] }],
      history: { pages: [[added('1001', 'm1')]], current: '1001', validStart: '1000' },
      inject: ({ path }) => (path === '/threads/t1' ? { status: 200, body: { id: 't1', messages: [noThreadId('m1')] } } : undefined),
    });
    const delta = await drainDelta(viaHistory, deltaAt('1000'), { exclusion: exclusionWith([domainRule('counsel', 'counsel.example')]) });
    expect(delta.flatMap((p) => p.skipped ?? [])).toMatchObject([{ providerItemId: 'm1', providerThreadId: 't1' }]);

    // None at all: a history record that names no thread fails closed before the thread or the message is asked for.
    const none = fakeGmail({
      address: ADDRESS,
      threads: [{ id: 't1', messages: [{ id: 'm1', internalDate: 1 }] }],
      history: { pages: [], validStart: '1000' },
      inject: ({ path }) =>
        path === '/history' ? { status: 200, body: { history: [{ id: '1001', messagesAdded: [{ message: { id: 'm1' } }] }], historyId: '1001' } } : undefined,
    });
    await expect(drainDelta(none, deltaAt('1000'))).rejects.toThrow('history record without a thread id');
    expect(none.log).toEqual(['history:1000']);
  });

  it('fails closed, as unevaluable, on a participant rule when an address header cannot be read; a marker rule is unaffected', async () => {
    const gmail = fakeGmail({
      address: ADDRESS,
      threads: [{ id: 't1', messages: [{ id: 'odd', internalDate: 1, to: [{ address: 'not-an-address' }] }] }],
    });
    const pages = await drain(gmail, { exclusion: exclusionWith([domainRule('counsel', 'counsel.example')]) });
    expect(pages.flatMap((p) => p.skipped ?? [])).toMatchObject([{ providerItemId: 'odd', reason: 'policy_unevaluable', policy: { ruleId: 'counsel' } }]);
    expect(gmail.log.some((l) => l.startsWith('raw:'))).toBe(false);

    const marker = fakeGmail({
      address: ADDRESS,
      threads: [{ id: 't1', messages: [{ id: 'odd', internalDate: 1, to: [{ address: 'not-an-address' }] }] }],
    });
    expect(idsOf(await drain(marker, { exclusion: exclusionWith([markerRule('private', 'sensitivity', 'private')]) }))).toEqual(['odd']);
  });

  it.each([
    ['Bcc', 'Outside Counsel <partner@counsel.example>'],
    ['Reply-To', 'Counsel Desk <desk@counsel.example>'],
    ['Sender', 'Assistant <assistant@counsel.example>'],
  ])('excludes before the fetch a message with counsel only in %s, and never parses it (#337)', async (header, value) => {
    parsed.calls.length = 0;
    const gmail = fakeGmail({
      address: ADDRESS,
      threads: [{ id: 't1', messages: [{ id: 'sent', internalDate: 1, to: [{ address: 'dana@heliotrope.example' }], headers: { [header]: value } }] }],
    });
    const pages = await drain(gmail, { exclusion: exclusionWith([domainRule('counsel', 'counsel.example')]) });
    expect(idsOf(pages)).toEqual([]);
    expect(pages.flatMap((p) => p.skipped ?? [])).toMatchObject([{ providerItemId: 'sent', reason: 'policy_excluded', policy: { ruleId: 'counsel' } }]);
    expect(gmail.log).toEqual(['profile', 'list', 'thread:t1']);
    expect(parsed.calls).toHaveLength(0);
  });

  it.each([
    ['Bcc', 'Outside Counsel <partner@counsel.example>'],
    ['Reply-To', 'Counsel Desk <desk@counsel.example>'],
    ['Sender', 'Assistant <assistant@counsel.example>'],
  ])('excludes before the fetch, on the history pass, a message with counsel only in %s (#337)', async (header, value) => {
    const gmail = fakeGmail({
      address: ADDRESS,
      threads: [{ id: 't1', messages: [{ id: 'sent', internalDate: 1, to: [{ address: 'dana@heliotrope.example' }], headers: { [header]: value } }] }],
      history: { pages: [[added('1001', 'sent')]], current: '1001', validStart: '1000' },
    });
    const pages = await drainDelta(gmail, deltaAt('1000'), { exclusion: exclusionWith([domainRule('counsel', 'counsel.example')]) });
    expect(idsOf(pages)).toEqual([]);
    expect(pages.flatMap((p) => p.skipped ?? [])).toMatchObject([{ providerItemId: 'sent', reason: 'policy_excluded', policy: { ruleId: 'counsel' } }]);
    expect(gmail.log.some((l) => l.startsWith('raw:'))).toBe(false);
  });

  it('fails closed on an address with two @, and matches a domain written with a trailing dot (#337 F1)', async () => {
    const twoAt = fakeGmail({
      address: ADDRESS,
      threads: [{ id: 't1', messages: [{ id: 'm1', internalDate: 1, headers: { Bcc: 'partner@counsel.example@outside.example' } }] }],
    });
    const pages = await drain(twoAt, { exclusion: exclusionWith([domainRule('counsel', 'counsel.example')]) });
    expect(pages.flatMap((p) => p.skipped ?? [])).toMatchObject([{ providerItemId: 'm1', reason: 'policy_unevaluable', policy: { ruleId: 'counsel' } }]);
    expect(twoAt.log).toEqual(['profile', 'list', 'thread:t1']);

    const dotted = fakeGmail({
      address: ADDRESS,
      threads: [{ id: 't1', messages: [{ id: 'm1', internalDate: 1, to: [{ address: 'partner@counsel.example.' }] }] }],
    });
    const excluded = await drain(dotted, { exclusion: exclusionWith([domainRule('counsel', 'counsel.example')]) });
    expect(excluded.flatMap((p) => p.skipped ?? [])).toMatchObject([{ providerItemId: 'm1', reason: 'policy_excluded', policy: { ruleId: 'counsel' } }]);
    expect(dotted.log).toEqual(['profile', 'list', 'thread:t1']);
  });

  it('reads a message whose Bcc names no counsel, and fails closed on an unreadable Bcc (#337)', async () => {
    const plain = fakeGmail({
      address: ADDRESS,
      threads: [{ id: 't1', messages: [{ id: 'ok', internalDate: 1, headers: { Bcc: 'alex.chen@bank.example' } }] }],
    });
    expect(idsOf(await drain(plain, { exclusion: exclusionWith([domainRule('counsel', 'counsel.example')]) }))).toEqual(['ok']);

    const odd = fakeGmail({
      address: ADDRESS,
      threads: [{ id: 't1', messages: [{ id: 'odd', internalDate: 1, headers: { Bcc: 'not-an-address' } }] }],
    });
    const pages = await drain(odd, { exclusion: exclusionWith([domainRule('counsel', 'counsel.example')]) });
    expect(pages.flatMap((p) => p.skipped ?? [])).toMatchObject([{ providerItemId: 'odd', reason: 'policy_unevaluable' }]);
    expect(odd.log.some((l) => l.startsWith('raw:'))).toBe(false);
  });

  it('refuses to read, before any request, with no exclusion context or an unavailable policy', async () => {
    for (const [exclusion, message] of [
      [undefined, 'needs the tenant exclusion policy'],
      [{ policy: { unavailable: 'missing' as const }, threadTaint: new Map() }, 'no exclusion policy'],
      [{ policy: { unavailable: 'invalid' as const }, threadTaint: new Map() }, 'exclusion policy is invalid'],
    ] as const) {
      const gmail = fakeGmail({ address: ADDRESS, threads: [{ id: 't1', messages: [{ id: 'm1', internalDate: 1 }] }] });
      let httpAsked = 0;
      const reader = createGmailMailContentSource({
        httpFor: async () => {
          httpAsked += 1;
          return gmail.http;
        },
        exclusion: exclusion as never,
      });
      const backfill = (async () => {
        for await (const page of reader.backfill(gmail.source, null)) void page;
      })();
      await expect(backfill).rejects.toThrow(message);
      const delta = (async () => {
        for await (const page of reader.delta(gmail.source, deltaAt('1000'))) void page;
      })();
      await expect(delta).rejects.toThrow(message);
      expect(gmail.log).toEqual([]);
      expect(httpAsked).toBe(0);
    }
  });
});

describe('the Gmail reader: label and classification rules (#263, phase 2)', () => {
  const LABELS = [
    { id: 'INBOX', name: 'INBOX' },
    { id: 'Label_1', name: 'Privileged' },
    { id: 'Label_2', name: 'HR' },
  ];
  const twoMessages = (over: Partial<FakeThread['messages'][number]> = {}): FakeThread[] => [
    { id: 't1', messages: [{ id: 'priv', internalDate: 1, labels: ['INBOX', 'Label_1'], ...over }, { id: 'ok', internalDate: 2 }] },
  ];

  it('asks labels.list once, after the profile and before the listing, only when a rule names a user label', async () => {
    const gmail = fakeGmail({ address: ADDRESS, threads: twoMessages(), labels: LABELS });
    const pages = await drain(gmail, { exclusion: exclusionWith([labelRule('privileged', 'Privileged')]) });
    expect(gmail.log).toEqual(['profile', 'labels', 'list', 'thread:t1', 'raw:ok']);
    expect(idsOf(pages)).toEqual(['ok']);
    expect(pages.flatMap((p) => p.skipped ?? [])).toMatchObject([
      { providerItemId: 'priv', providerThreadId: 't1', reason: 'policy_excluded', policy: { ruleId: 'privileged' } },
    ]);
  });

  it('asks no labels.list for a policy without a label rule, or whose label rules name built-in labels only', async () => {
    for (const rules of [[], [domainRule('counsel', 'counsel.example')], [labelRule('personal', 'CATEGORY_PERSONAL', 'inbox')]]) {
      const gmail = fakeGmail({ address: ADDRESS, threads: twoMessages({ labels: ['INBOX', 'CATEGORY_PERSONAL'] }) });
      await drain(gmail, { exclusion: exclusionWith(rules) });
      expect(gmail.log, JSON.stringify(rules)).not.toContain('labels');
    }
    // A built-in label rule still matches, on the id the message carries.
    const gmail = fakeGmail({ address: ADDRESS, threads: twoMessages({ labels: ['INBOX', 'CATEGORY_PERSONAL'] }) });
    const pages = await drain(gmail, { exclusion: exclusionWith([labelRule('personal', 'category_personal')]) });
    expect(idsOf(pages)).toEqual(['ok']);
  });

  it('matches a label by its name case-insensitively, and does not match a different label', async () => {
    const gmail = fakeGmail({
      address: ADDRESS,
      threads: [{ id: 't1', messages: [{ id: 'priv', internalDate: 1, labels: ['INBOX', 'Label_1'] }, { id: 'hr', internalDate: 2, labels: ['INBOX', 'Label_2'] }] }],
      labels: LABELS,
    });
    const pages = await drain(gmail, { exclusion: exclusionWith([labelRule('privileged', 'pRIVILEGED')]) });
    expect(idsOf(pages)).toEqual(['hr']);
    expect(gmail.log.filter((l) => l.startsWith('raw:'))).toEqual(['raw:hr']);
  });

  it('counts labels.list in the page budget: no page holds more than the bound, labels.list included', async () => {
    const messages = Array.from({ length: 60 }, (_, i) => ({ id: `n${i + 1}`, internalDate: i + 1 }));
    const gmail = fakeGmail({ address: ADDRESS, threads: [{ id: 't1', messages }], labels: LABELS });
    let last = 0;
    const spans: number[] = [];
    const reader = createGmailMailContentSource({ httpFor: async () => gmail.http, exclusion: exclusionWith([labelRule('privileged', 'Privileged')]) });
    for await (const page of reader.backfill(gmail.source, null)) {
      void page;
      spans.push(gmail.log.length - last);
      last = gmail.log.length;
    }
    expect(gmail.log.filter((l) => l === 'labels')).toHaveLength(1);
    expect(spans[0]).toBe(MAX_GMAIL_REQUESTS_PER_PAGE);
    expect(Math.max(...spans)).toBeLessThanOrEqual(MAX_GMAIL_REQUESTS_PER_PAGE);
  });

  it('asks labels.list once for an incremental pass too, before its first history page is read', async () => {
    const gmail = fakeGmail({
      address: ADDRESS,
      threads: twoMessages(),
      labels: LABELS,
      history: { pages: [[added('1001', 'priv', 'ok')]], current: '1001', validStart: '1000' },
    });
    const pages = await drainDelta(gmail, deltaAt('1000'), { exclusion: exclusionWith([labelRule('privileged', 'Privileged')]) });
    expect(gmail.log).toEqual(['labels', 'history:1000', 'thread:t1', 'raw:ok']);
    expect(idsOf(pages)).toEqual(['ok']);
    expect(pages.flatMap((p) => p.skipped ?? []).map((s) => [s.providerItemId, s.reason])).toEqual([['priv', 'policy_excluded']]);
  });

  it('fails closed, as unevaluable, on a user label labels.list did not name', async () => {
    const gmail = fakeGmail({
      address: ADDRESS,
      threads: [{ id: 't1', messages: [{ id: 'new', internalDate: 1, labels: ['INBOX', 'Label_99'] }] }],
      labels: LABELS,
    });
    const pages = await drain(gmail, { exclusion: exclusionWith([labelRule('privileged', 'Privileged')]) });
    expect(pages.flatMap((p) => p.skipped ?? [])).toMatchObject([{ providerItemId: 'new', reason: 'policy_unevaluable', policy: { ruleId: 'privileged' } }]);
    expect(gmail.log.some((l) => l.startsWith('raw:'))).toBe(false);
  });

  it('excludes on a classification label value without a raw fetch, and fails closed on a message that carries none (unverified field)', async () => {
    const gmail = fakeGmail({
      address: ADDRESS,
      threads: [
        {
          id: 't1',
          messages: [
            { id: 'classified', internalDate: 1, classification: [{ labelId: 'L1', fields: [{ fieldId: 'F1', selection: 'restricted' }] }] },
            { id: 'plain', internalDate: 2 },
            { id: 'other', internalDate: 3, classification: [{ labelId: 'L9' }] },
          ],
        },
      ],
    });
    const pages = await drain(gmail, { exclusion: exclusionWith([classificationRule('restricted', 'L1', 'F1', 'restricted')]) });
    expect(pages.flatMap((p) => p.skipped ?? []).map((s) => [s.providerItemId, s.reason])).toEqual([
      ['classified', 'policy_excluded'],
      ['plain', 'policy_unevaluable'],
    ]);
    // The message whose field says another label is evaluated normally: its presence proves support.
    expect(idsOf(pages)).toEqual(['other']);
    expect(gmail.log.filter((l) => l.startsWith('raw:'))).toEqual(['raw:other']);
  });

  describe('a label added between the metadata and the raw read (R10)', () => {
    const racy = () =>
      fakeGmail({
        address: ADDRESS,
        threads: [
          {
            id: 't1',
            messages: [
              { id: 'racy', internalDate: 1, labels: ['INBOX'], rawLabels: ['INBOX', 'Label_1'] },
              { id: 'calm', internalDate: 2 },
            ],
          },
        ],
        labels: LABELS,
      });

    it('is fetched (raw in the log), discarded unparsed, ledgered as policy_excluded_after_fetch, and emits no item', async () => {
      parsed.calls.length = 0;
      const gmail = racy();
      const pages = await drain(gmail, { exclusion: exclusionWith([labelRule('privileged', 'Privileged')], 4) });
      // Honest: the body did cross. It is the only thing the policy could not stop.
      expect(gmail.log).toContain('raw:racy');
      expect(idsOf(pages)).toEqual(['calm']);
      expect(pages.flatMap((p) => p.skipped ?? [])).toEqual([
        {
          providerItemId: 'racy',
          providerThreadId: 't1',
          itemHash: expect.stringMatching(/^[0-9a-f]{64}$/),
          reason: 'policy_excluded_after_fetch',
          policy: { version: 4, ruleId: 'privileged' },
        },
      ]);
      // parseRaw ran for the calm message only: the discarded raw never reached the parser.
      expect(parsed.calls).toHaveLength(1);
    });

    it('does the same on the incremental pass', async () => {
      parsed.calls.length = 0;
      const gmail = fakeGmail({
        address: ADDRESS,
        threads: [{ id: 't1', messages: [{ id: 'racy', internalDate: 1, rawLabels: ['INBOX', 'Label_1'] }] }],
        labels: LABELS,
        history: { pages: [[added('1001', 'racy')]], current: '1001', validStart: '1000' },
      });
      const pages = await drainDelta(gmail, deltaAt('1000'), { exclusion: exclusionWith([labelRule('privileged', 'Privileged')]) });
      expect(idsOf(pages)).toEqual([]);
      expect(pages.flatMap((p) => p.skipped ?? [])).toMatchObject([{ providerItemId: 'racy', reason: 'policy_excluded_after_fetch' }]);
      expect(parsed.calls).toHaveLength(0);
    });

    it('keeps its hash equal to the metadata-time hash of the same message, so the bank can recompute it', async () => {
      const raced = await drain(racy(), { exclusion: exclusionWith([labelRule('privileged', 'Privileged')]) });
      const before = await drain(
        fakeGmail({ address: ADDRESS, threads: [{ id: 't1', messages: [{ id: 'racy', internalDate: 1, labels: ['INBOX', 'Label_1'] }] }], labels: LABELS }),
        { exclusion: exclusionWith([labelRule('privileged', 'Privileged')]) },
      );
      expect(raced.flatMap((p) => p.skipped ?? [])[0].itemHash).toBe(before.flatMap((p) => p.skipped ?? [])[0].itemHash);
    });

    it('is not a thing when no label rule matches: the message is read as usual', async () => {
      const gmail = racy();
      const pages = await drain(gmail, { exclusion: exclusionWith([labelRule('hr', 'HR')]) });
      expect(idsOf(pages)).toEqual(['racy', 'calm']);
      expect(pages.flatMap((p) => p.skipped ?? [])).toEqual([]);
    });
  });
});

describe('the Gmail reader: thread-scoped rules (#263, phase 3)', () => {
  const COUNSEL = inThread(domainRule('counsel', 'counsel.example'));
  const LABELS = [
    { id: 'INBOX', name: 'INBOX' },
    { id: 'Label_1', name: 'Privileged' },
  ];
  const PRIVILEGED = inThread(labelRule('privileged', 'Privileged'));
  const skippedOf = (pages: SourceItemPage[]) => pages.flatMap((p) => p.skipped ?? []);
  const taintsOf = (pages: SourceItemPage[]) => pages.flatMap((p) => p.threadTaints ?? []);
  const reasons = (pages: SourceItemPage[]) => Object.fromEntries(skippedOf(pages).map((s) => [s.providerItemId, `${s.reason}:${s.policy?.ruleId}`]));

  // A conversation in which the middle message copies counsel: the one before it, the match and the one after.
  const conversation = (): FakeThread[] => [
    {
      id: 't1',
      messages: [
        { id: 'before', internalDate: 1 },
        { id: 'trigger', internalDate: 2, cc: [{ address: 'partner@counsel.example' }] },
        { id: 'after', internalDate: 3 },
      ],
    },
    { id: 't2', messages: [{ id: 'other', internalDate: 4 }] },
  ];

  it('excludes the whole conversation when one message matches: the trigger as its own match, the rest as inherited, none fetched raw', async () => {
    const gmail = fakeGmail({ address: ADDRESS, threads: conversation() });
    const pages = await drain(gmail, { exclusion: exclusionWith([COUNSEL], 4) });
    expect(reasons(pages)).toEqual({
      before: 'policy_thread_excluded:counsel',
      trigger: 'policy_excluded:counsel',
      after: 'policy_thread_excluded:counsel',
    });
    // The other conversation is read as usual, and nothing of the tainted one was requested raw.
    expect(idsOf(pages)).toEqual(['other']);
    expect(gmail.log).toEqual(['profile', 'list', 'thread:t1', 'thread:t2', 'raw:other']);
    for (const skip of skippedOf(pages)) expect(skip).toMatchObject({ providerThreadId: 't1', policy: { version: 4 } });
    // One taint for the thread and rule, carrying the message that first matched.
    expect(taintsOf(pages)).toEqual([{ providerThreadId: 't1', providerItemId: 'trigger', ruleId: 'counsel', policyVersion: 4 }]);
  });

  it('excludes only the matching message under a message-scoped rule, and taints nothing', async () => {
    const gmail = fakeGmail({ address: ADDRESS, threads: conversation() });
    const pages = await drain(gmail, { exclusion: exclusionWith([domainRule('counsel', 'counsel.example')]) });
    expect(idsOf(pages)).toEqual(['before', 'after', 'other']);
    expect(Object.keys(reasons(pages))).toEqual(['trigger']);
    expect(taintsOf(pages)).toEqual([]);
  });

  it('inherits a persisted taint: a clean message of a thread the worker names is never fetched, and no taint is emitted again', async () => {
    const gmail = fakeGmail({ address: ADDRESS, threads: [{ id: 't1', messages: [{ id: 'reply', internalDate: 1 }] }, { id: 't2', messages: [{ id: 'other', internalDate: 2 }] }] });
    const pages = await drain(gmail, { exclusion: exclusionWith([COUNSEL], 5, { t1: ['counsel'] }) });
    expect(reasons(pages)).toEqual({ reply: 'policy_thread_excluded:counsel' });
    expect(idsOf(pages)).toEqual(['other']);
    expect(gmail.log.filter((l) => l.startsWith('raw:'))).toEqual(['raw:other']);
    expect(taintsOf(pages)).toEqual([]);
  });

  it('taints from every thread-scoped match whichever rule is listed first: a message rule first still taints the thread', async () => {
    for (const rules of [
      [domainRule('counsel-message', 'counsel.example'), PRIVILEGED],
      [PRIVILEGED, domainRule('counsel-message', 'counsel.example')],
    ]) {
      const gmail = fakeGmail({
        address: ADDRESS,
        labels: LABELS,
        threads: [
          {
            id: 't1',
            messages: [
              { id: 'both', internalDate: 1, labels: ['INBOX', 'Label_1'], cc: [{ address: 'partner@counsel.example' }] },
              { id: 'reply', internalDate: 2 },
            ],
          },
        ],
      });
      const pages = await drain(gmail, { exclusion: exclusionWith(rules) });
      // The ledger names the first match; the taint comes from the thread-scoped one, in either order.
      expect(reasons(pages).both).toBe(`policy_excluded:${rules[0].id}`);
      expect(reasons(pages).reply).toBe('policy_thread_excluded:privileged');
      expect(taintsOf(pages)).toMatchObject([{ ruleId: 'privileged', providerItemId: 'both' }]);
      expect(gmail.log.some((l) => l.startsWith('raw:'))).toBe(false);
    }
  });

  it('fails closed on a thread-scoped rule that cannot be evaluated: the conversation is excluded, and no taint is written', async () => {
    const gmail = fakeGmail({
      address: ADDRESS,
      threads: [{ id: 't1', messages: [{ id: 'odd', internalDate: 1, to: [{ address: 'not-an-address' }] }, { id: 'fine', internalDate: 2 }] }],
    });
    const pages = await drain(gmail, { exclusion: exclusionWith([COUNSEL]) });
    expect(reasons(pages)).toEqual({ odd: 'policy_unevaluable:counsel', fine: 'policy_thread_excluded:counsel' });
    expect(gmail.log.filter((l) => l.startsWith('raw:'))).toEqual([]);
    // A taint is permanent; an unknown is not a match (security review, batch 2).
    expect(taintsOf(pages)).toEqual([]);
  });

  it('excludes every message under an unverified thread-scoped classification rule, and taints no thread', async () => {
    const gmail = fakeGmail({
      address: ADDRESS,
      threads: [
        { id: 't1', messages: [{ id: 'a', internalDate: 1 }, { id: 'b', internalDate: 2 }] },
        { id: 't2', messages: [{ id: 'c', internalDate: 3 }] },
      ],
    });
    const pages = await drain(gmail, { exclusion: exclusionWith([inThread(classificationRule('restricted', 'conf-label-1'))]) });
    expect(reasons(pages)).toEqual({
      a: 'policy_unevaluable:restricted',
      b: 'policy_unevaluable:restricted',
      c: 'policy_unevaluable:restricted',
    });
    expect(gmail.log.filter((l) => l.startsWith('raw:'))).toEqual([]);
    expect(taintsOf(pages)).toEqual([]);
  });

  it('taints the thread from a label found on the raw fetch, for the messages not read yet', async () => {
    const gmail = fakeGmail({
      address: ADDRESS,
      labels: LABELS,
      threads: [
        {
          id: 't1',
          messages: [
            { id: 'racy', internalDate: 1, labels: ['INBOX'], rawLabels: ['INBOX', 'Label_1'] },
            { id: 'later', internalDate: 2 },
            { id: 'last', internalDate: 3 },
          ],
        },
      ],
    });
    const pages = await drain(gmail, { exclusion: exclusionWith([PRIVILEGED], 2) });
    // The raced message was fetched (its body had crossed); nothing after it in the conversation was.
    expect(gmail.log.filter((l) => l.startsWith('raw:'))).toEqual(['raw:racy']);
    expect(reasons(pages)).toEqual({
      racy: 'policy_excluded_after_fetch:privileged',
      later: 'policy_thread_excluded:privileged',
      last: 'policy_thread_excluded:privileged',
    });
    expect(idsOf(pages)).toEqual([]);
    expect(taintsOf(pages)).toEqual([{ providerThreadId: 't1', providerItemId: 'racy', ruleId: 'privileged', policyVersion: 2 }]);
  });

  it('carries the thread id on every message it reads, not only on the skipped ones', async () => {
    const gmail = fakeGmail({ address: ADDRESS, threads: conversation() });
    const pages = await drain(gmail);
    expect(pages.flatMap((p) => p.items).map((m) => [m.id, m.providerThreadId])).toEqual([
      ['before', 't1'],
      ['trigger', 't1'],
      ['after', 't1'],
      ['other', 't2'],
    ]);
  });

  it('judges a resumed thread whole: a message already read before the resume still taints the rest', async () => {
    // Run 1 read t1's first message (no taint then); the resume names the second, which now matches.
    const gmail = fakeGmail({
      address: ADDRESS,
      threads: [{ id: 't1', messages: [{ id: 'first', internalDate: 1 }, { id: 'second', internalDate: 2, cc: [{ address: 'partner@counsel.example' }] }, { id: 'third', internalDate: 3 }] }],
    });
    const pages = await drain(gmail, {
      exclusion: exclusionWith([COUNSEL]),
      checkpoint: checkpointOf({ pageToken: null, nextThreadId: 't1', nextMessageId: 'second' }),
    });
    expect(reasons(pages)).toEqual({ second: 'policy_excluded:counsel', third: 'policy_thread_excluded:counsel' });
    expect(taintsOf(pages)).toMatchObject([{ providerItemId: 'second' }]);
    expect(gmail.log.some((l) => l.startsWith('raw:'))).toBe(false);
  });

  describe('on the incremental pass', () => {
    it('reads the whole conversation with threads.get, so a clean reply to an older excluded message is never fetched', async () => {
      // history names only the reply; the older message in the thread carries the counsel address.
      const gmail = fakeGmail({
        address: ADDRESS,
        threads: [{ id: 't1', messages: [{ id: 'old', internalDate: 1, cc: [{ address: 'partner@counsel.example' }] }, { id: 'reply', internalDate: 2 }] }],
        history: { pages: [[added('1001', 'reply')]], current: '1001', validStart: '1000' },
      });
      const pages = await drainDelta(gmail, deltaAt('1000'), { exclusion: exclusionWith([COUNSEL], 3) });
      expect(gmail.log).toEqual(['history:1000', 'thread:t1']);
      expect(reasons(pages)).toEqual({ reply: 'policy_thread_excluded:counsel' });
      // The older message is not named by history, so it is not ledgered again; its taint is emitted.
      expect(taintsOf(pages)).toEqual([{ providerThreadId: 't1', providerItemId: 'old', ruleId: 'counsel', policyVersion: 3 }]);
    });

    it('excludes a clean reply by the persisted taint alone, once the message that matched has lost its label', async () => {
      const gmail = fakeGmail({
        address: ADDRESS,
        labels: LABELS,
        threads: [{ id: 't1', messages: [{ id: 'old', internalDate: 1 }, { id: 'reply', internalDate: 2 }] }],
        history: { pages: [[added('1001', 'reply')]], current: '1001', validStart: '1000' },
      });
      const pages = await drainDelta(gmail, deltaAt('1000'), { exclusion: exclusionWith([PRIVILEGED], 2, { t1: ['privileged'] }) });
      expect(reasons(pages)).toEqual({ reply: 'policy_thread_excluded:privileged' });
      expect(gmail.log).toEqual(['labels', 'history:1000', 'thread:t1']);
      expect(taintsOf(pages)).toEqual([]);
    });

    it('holds a taint set on one history page for the next: the thread is read again, and no longer shows the match', async () => {
      let reads = 0;
      const gmail = fakeGmail({
        address: ADDRESS,
        labels: LABELS,
        threads: [{ id: 't1', messages: [{ id: 'm1', internalDate: 1, labels: ['INBOX', 'Label_1'] }, { id: 'm2', internalDate: 2 }] }],
        history: { pages: [[added('1001', 'm1')], [added('1002', 'm2')]], current: '1002', validStart: '1000' },
        // The second read of the thread finds m1 without its label: only the pass's memory still knows.
        inject: ({ path }) => {
          if (path !== '/threads/t1') return undefined;
          reads += 1;
          if (reads < 2) return undefined;
          const meta = (id: string, internalDate: number) => ({
            id, threadId: 't1', labelIds: ['INBOX'], internalDate: String(internalDate),
            payload: { headers: [{ name: 'From', value: 'a@bank.example' }, { name: 'To', value: 'b@bank.example' }, { name: 'Message-ID', value: `<${id}@x.example>` }] },
          });
          return { status: 200, body: { id: 't1', messages: [meta('m1', 1), meta('m2', 2)] } };
        },
      });
      const pages = await drainDelta(gmail, deltaAt('1000'), { exclusion: exclusionWith([PRIVILEGED]) });
      expect(reasons(pages)).toEqual({ m1: 'policy_excluded:privileged', m2: 'policy_thread_excluded:privileged' });
      expect(gmail.log.filter((l) => l.startsWith('raw:'))).toEqual([]);
      // One taint, from the first page: the second page adds nothing.
      expect(taintsOf(pages)).toHaveLength(1);
    });

    it('emits the taint with the page it was found on', async () => {
      const gmail = fakeGmail({
        address: ADDRESS,
        threads: [{ id: 't1', messages: [{ id: 'm1', internalDate: 1, cc: [{ address: 'partner@counsel.example' }] }] }],
        history: { pages: [[added('1001', 'm1')]], current: '1001', validStart: '1000' },
      });
      const pages = await drainDelta(gmail, deltaAt('1000'), { exclusion: exclusionWith([COUNSEL], 6) });
      expect(pages).toHaveLength(1);
      expect(pages[0].threadTaints).toEqual([{ providerThreadId: 't1', providerItemId: 'm1', ruleId: 'counsel', policyVersion: 6 }]);
    });

    it('reads a thread once per history page and makes no more requests than messages.get per message did', async () => {
      const gmail = fakeGmail({
        address: ADDRESS,
        threads: [
          { id: 't1', messages: [{ id: 'a', internalDate: 1 }, { id: 'b', internalDate: 2 }] },
          { id: 't2', messages: [{ id: 'c', internalDate: 3 }] },
        ],
        history: { pages: [[added('1001', 'a', 'b', 'c')]], current: '1001', validStart: '1000' },
      });
      await drainDelta(gmail, deltaAt('1000'));
      expect(gmail.log).toEqual(['history:1000', 'thread:t1', 'thread:t2', 'raw:a', 'raw:b', 'raw:c']);
    });
  });
});

// ── The pass record's counts (#370) ──────────────────────────────────────────
// `fetched` counts every format=raw response that came back (its body crossed the wire, R2-M1), whatever the reader
// then did with it; `excluded` counts the policy skips decided on metadata, before any content request.
describe('the Gmail reader: fetched and excluded counts per page (#370)', () => {
  const LABELS = [
    { id: 'INBOX', name: 'INBOX' },
    { id: 'Label_1', name: 'Privileged' },
  ];
  const total = (pages: SourceItemPage[], key: 'fetched' | 'excluded') => pages.reduce((sum, page) => sum + (page[key] ?? 0), 0);

  it('counts 1 for each raw response that returned: stored, excluded after the fetch, a late DRAFT label, no raw, over 25 MiB', async () => {
    const big = Buffer.alloc(MAX_RAW_BYTES + 1, 0x61).toString('base64url');
    const gmail = fakeGmail({
      address: ADDRESS,
      labels: LABELS,
      threads: [
        {
          id: 't1',
          messages: [
            { id: 'stored', internalDate: 1 },
            { id: 'racy', internalDate: 2, rawLabels: ['INBOX', 'Label_1'] },
            { id: 'drafted', internalDate: 3, rawLabels: ['INBOX', 'DRAFT'] },
            { id: 'empty', internalDate: 4, raw: '' },
            { id: 'huge', internalDate: 5, raw: big },
          ],
        },
      ],
    });
    const pages = await drain(gmail, { exclusion: exclusionWith([labelRule('privileged', 'Privileged')]) });
    expect(gmail.log.filter((l) => l.startsWith('raw:'))).toHaveLength(5);
    expect(idsOf(pages)).toEqual(['stored']);
    expect(total(pages, 'fetched')).toBe(5);
    expect(total(pages, 'excluded')).toBe(0);
  });

  it('counts the pre-fetch policy skips as excluded, never also as fetched, and a metadata-time built-in label in neither', async () => {
    const gmail = fakeGmail({
      address: ADDRESS,
      threads: [
        {
          id: 't1',
          messages: [
            { id: 'ok', internalDate: 1 },
            { id: 'spam', internalDate: 2, labels: ['SPAM'] },
            { id: 'skipme', internalDate: 3, headers: { Sensitivity: 'Private' } },
            { id: 'skipme2', internalDate: 4, headers: { Sensitivity: 'Private' } },
          ],
        },
      ],
    });
    const pages = await drain(gmail, { exclusion: exclusionWith([markerRule('private', 'sensitivity', 'private')]) });
    expect(total(pages, 'fetched')).toBe(1);
    expect(total(pages, 'excluded')).toBe(2);
  });

  it('counts a delta 404 on the raw read as 0, and the messages read beside it as 1 each', async () => {
    const gmail = fakeGmail({
      address: ADDRESS,
      threads: [{ id: 't1', messages: [{ id: 'kept', internalDate: 3 }, { id: 'goneRaw', internalDate: 2 }] }],
      history: { pages: [[added('1002', 'goneRaw', 'kept')]], current: '1002', validStart: '1000' },
      inject: ({ path, url }) =>
        path === '/messages/goneRaw' && url.searchParams.get('format') === 'raw' ? { status: 404 } : undefined,
    });
    const pages = await drainDelta(gmail, deltaAt('1000'));
    expect(gmail.log).toContain('raw:goneRaw');
    expect(total(pages, 'fetched')).toBe(1);
  });

  it('counts the delta pass the same way: an after-fetch exclusion is fetched, a pre-fetch one excluded', async () => {
    const gmail = fakeGmail({
      address: ADDRESS,
      labels: LABELS,
      threads: [
        {
          id: 't1',
          messages: [
            { id: 'racy', internalDate: 1, rawLabels: ['INBOX', 'Label_1'] },
            { id: 'priv', internalDate: 2, labels: ['INBOX', 'Label_1'] },
            { id: 'ok', internalDate: 3 },
          ],
        },
      ],
      history: { pages: [[added('1001', 'racy', 'priv', 'ok')]], current: '1001', validStart: '1000' },
    });
    const pages = await drainDelta(gmail, deltaAt('1000'), { exclusion: exclusionWith([labelRule('privileged', 'Privileged')]) });
    expect(total(pages, 'fetched')).toBe(2);
    expect(total(pages, 'excluded')).toBe(1);
  });

  it('does not count a raw request that throws: the page it was in throws before it yields', async () => {
    const threads = Array.from({ length: THREADS_PER_CHUNK + 1 }, (_, i) => threadOf(`t${i + 1}`, 1));
    const last = threads[THREADS_PER_CHUNK].messages[0].id;
    const gmail = fakeGmail({
      address: ADDRESS,
      threads,
      inject: ({ path, url }) => (path === `/messages/${last}` && url.searchParams.get('format') === 'raw' ? { status: 500 } : undefined),
    });
    const reader = createGmailMailContentSource({ httpFor: async () => gmail.http, exclusion: NO_EXCLUSION });
    const pages: SourceItemPage[] = [];
    await expect(
      (async () => {
        for await (const page of reader.backfill(gmail.source, null)) pages.push(page);
      })(),
    ).rejects.toBeInstanceOf(GoogleHttpError);
    expect(pages).toHaveLength(1);
    expect(pages[0].fetched).toBe(THREADS_PER_CHUNK);
  });

  it('resets the counts at every page, and carries both on every page, zero included', async () => {
    const threads = Array.from({ length: THREADS_PER_CHUNK + 1 }, (_, i) => threadOf(`t${i + 1}`, 1));
    const pages = await drain(fakeGmail({ address: ADDRESS, threads }));
    expect(pages.map((page) => [page.fetched, page.excluded])).toEqual([
      [THREADS_PER_CHUNK, 0],
      [1, 0],
    ]);
    const empty = await drain(fakeGmail({ address: ADDRESS, threads: [] }));
    expect(empty.map((page) => [page.fetched, page.excluded])).toEqual([[0, 0]]);
  });
});

// ── The ingestion window (#353) ──────────────────────────────────────────────

describe('the Gmail reader: a first read takes only its window (#353)', () => {
  const WINDOW = '2026-07-17';
  const FLOOR = Date.UTC(2026, 6, 17);
  const DAY = 86_400_000;
  const Q = `q=after%3A${FLOOR / 1000 - 86_400}`;
  const listUrls = (gmail: ReturnType<typeof fakeGmail>) => gmail.urls.filter((u) => /\/threads\?/.test(u));
  const raws = (gmail: ReturnType<typeof fakeGmail>) => gmail.log.filter((l) => l.startsWith('raw:'));
  const ledgered = (pages: SourceItemPage[]) => pages.flatMap((p) => p.skipped ?? []).map((s) => s.providerItemId);

  // old: entirely before the window. mixed: an old message and a reply in the window. edge: one message a millisecond
  // before the floor (inside the listing's day of slack) and one exactly at it. fresh: in the window only.
  const threads: FakeThread[] = [
    { id: 'old', messages: [{ id: 'old-1', internalDate: FLOOR - 30 * DAY }] },
    { id: 'mixed', messages: [{ id: 'mixed-old', internalDate: FLOOR - 10 * DAY }, { id: 'mixed-new', internalDate: FLOOR + DAY }] },
    { id: 'edge', messages: [{ id: 'edge-before', internalDate: FLOOR - 1 }, { id: 'edge-at', internalDate: FLOOR }] },
    { id: 'fresh', messages: [{ id: 'fresh-1', internalDate: FLOOR + 2 * DAY }] },
  ];

  it('lists with q=after: one day before the floor, and stores only mail on or after it', async () => {
    const gmail = fakeGmail({ address: ADDRESS, threads, backfillSince: WINDOW });
    const pages = await drain(gmail);
    expect(listUrls(gmail)).toEqual([
      `https://gmail.googleapis.com/gmail/v1/users/storm.duncan%40bank.example/threads?maxResults=100&includeSpamTrash=false` +
        `&fields=threads(id,historyId),nextPageToken&${Q}`,
    ]);
    // The thread wholly before the window is never listed, so never read at all.
    expect(gmail.log).not.toContain('thread:old');
    expect(idsOf(pages)).toEqual(['mixed-new', 'edge-at', 'fresh-1']);
    expect(raws(gmail)).toEqual(['raw:mixed-new', 'raw:edge-at', 'raw:fresh-1']);
    // Nothing older than the window is ledgered: no skip row, no count.
    expect(ledgered(pages)).toEqual([]);
    expect(pages.reduce((sum, p) => sum + (p.excluded ?? 0), 0)).toBe(0);
  });

  it('lists without q, exactly as before, when the source has no window', async () => {
    for (const backfillSince of [null, undefined]) {
      const gmail = fakeGmail({ address: ADDRESS, threads, backfillSince });
      const pages = await drain(gmail);
      expect(listUrls(gmail)).toEqual([
        'https://gmail.googleapis.com/gmail/v1/users/storm.duncan%40bank.example/threads?maxResults=100&includeSpamTrash=false' +
          '&fields=threads(id,historyId),nextPageToken',
      ]);
      expect(idsOf(pages)).toEqual(['old-1', 'mixed-old', 'mixed-new', 'edge-before', 'edge-at', 'fresh-1']);
      // And the checkpoint carries no window: byte for byte what it was before #353.
      expect(pages.every((p) => !p.nextCheckpoint?.includes('since'))).toBe(true);
    }
  });

  it('keeps q on every listing page of the pass', async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ id: `t${i}`, messages: [{ id: `t${i}-m`, internalDate: FLOOR + i }] }));
    const gmail = fakeGmail({ address: ADDRESS, threads: many, listPageSize: 2, backfillSince: WINDOW });
    const pages = await drain(gmail);
    expect(idsOf(pages)).toEqual(many.map((t) => t.messages[0].id));
    expect(listUrls(gmail)).toHaveLength(3);
    expect(listUrls(gmail).every((u) => u.includes(`&${Q}`))).toBe(true);
  });

  it('judges a pre-window message with its thread: its thread-scoped taint still excludes the reply in the window', async () => {
    const tainted: FakeThread[] = [
      {
        id: 't1',
        messages: [
          { id: 'old-counsel', internalDate: FLOOR - 5 * DAY, to: [{ address: 'partner@counsel.example' }] },
          { id: 'new-reply', internalDate: FLOOR + DAY },
        ],
      },
    ];
    const gmail = fakeGmail({ address: ADDRESS, threads: tainted, backfillSince: WINDOW });
    const pages = await drain(gmail, { exclusion: exclusionWith([inThread(domainRule('counsel', 'counsel.example'))], 4) });
    expect(idsOf(pages)).toEqual([]);
    expect(raws(gmail)).toEqual([]);
    // The reply is ledgered as excluded by the thread's taint; the old message is not ledgered at all.
    expect(ledgered(pages)).toEqual(['new-reply']);
    expect(pages.flatMap((p) => p.threadTaints ?? [])).toEqual([
      { providerThreadId: 't1', providerItemId: 'old-counsel', ruleId: 'counsel', policyVersion: 4 },
    ]);
  });

  it('pins the window into every checkpoint of the pass, and carries it into the delta checkpoint', async () => {
    const many = Array.from({ length: THREADS_PER_CHUNK + 2 }, (_, i) => ({ id: `t${i}`, messages: [{ id: `t${i}-m`, internalDate: FLOOR + i }] }));
    const gmail = fakeGmail({ address: ADDRESS, threads: many, backfillSince: WINDOW });
    const pages = await drain(gmail);
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) expect(parseCheckpoint(page.nextCheckpoint).since).toBe(WINDOW);
    expect(lastCheckpoint(pages)).toMatchObject({ phase: 'delta', historyId: gmail.historyId, since: WINDOW });
  });

  it('keeps the window it started with when the source window changes mid-pass', async () => {
    const many = Array.from({ length: THREADS_PER_CHUNK + 2 }, (_, i) => ({ id: `t${i}`, messages: [{ id: `t${i}-m`, internalDate: FLOOR + i }] }));
    const first = fakeGmail({ address: ADDRESS, threads: many, backfillSince: WINDOW });
    const run1 = await drain(first, { stopAfter: 1 });
    const checkpoint = run1[0].nextCheckpoint;
    expect(parseCheckpoint(checkpoint)).toMatchObject({ phase: 'backfill', since: WINDOW });

    const second = fakeGmail({ address: ADDRESS, threads: many, backfillSince: '2026-01-01' });
    const run2 = await drain(second, { checkpoint });
    expect(listUrls(second).every((u) => u.includes(`&${Q}`))).toBe(true);
    expect(lastCheckpoint(run2).since).toBe(WINDOW);
    expect(idsOf([...run1, ...run2])).toEqual(many.map((t) => t.messages[0].id));
  });

  it('resumes a checkpoint stored before the window as it was: the whole mailbox, whatever the source says now', async () => {
    const legacy = checkpointOf({ pageToken: null, nextThreadId: 'mixed' });
    expect(JSON.parse(legacy)).not.toHaveProperty('since');
    const gmail = fakeGmail({ address: ADDRESS, threads, backfillSince: WINDOW });
    const pages = await drain(gmail, { checkpoint: legacy });
    expect(listUrls(gmail).some((u) => u.includes('q='))).toBe(false);
    expect(idsOf(pages)).toEqual(['mixed-old', 'mixed-new', 'edge-before', 'edge-at', 'fresh-1']);
    expect(lastCheckpoint(pages).since).toBeUndefined();
  });

  it('keeps the window through a delta pass, which itself reads history unchanged', async () => {
    const gmail = fakeGmail({
      address: ADDRESS,
      threads,
      history: { pages: [[added('1001', 'mixed-old')]], current: '1001', validStart: '1000' },
    });
    const pages = await drainDelta(gmail, deltaAt('1000', { since: WINDOW }));
    // Delta has no floor (#353 F3): history names the message and it is read.
    expect(idsOf(pages)).toEqual(['mixed-old']);
    expect(gmail.urls.some((u) => u.includes('q='))).toBe(false);
    expect(lastCheckpoint(pages)).toMatchObject({ phase: 'delta', historyId: '1001', since: WINDOW });
  });

  it('refuses a checkpoint whose window is not a YYYY-MM-DD day', async () => {
    for (const since of ['2026/07/17', '2026-02-30', 20260717, '']) {
      const bad = JSON.stringify({ ...JSON.parse(checkpointOf({})), since });
      expect(() => parseCheckpoint(bad), String(since)).toThrow('gmail reader: unreadable checkpoint');
    }
    expect(parseCheckpoint(JSON.stringify({ ...JSON.parse(checkpointOf({})), since: null })).since).toBeNull();
  });

  it('reads the whole mailbox under a reader built without the window (the replay)', async () => {
    const gmail = fakeGmail({ address: ADDRESS, threads, backfillSince: WINDOW });
    const reader = createGmailMailContentSource({ httpFor: async () => gmail.http, exclusion: NO_EXCLUSION, honourWindow: false });
    const pages: SourceItemPage[] = [];
    for await (const page of reader.backfill(gmail.source, null)) pages.push(page);
    expect(listUrls(gmail).some((u) => u.includes('q='))).toBe(false);
    expect(idsOf(pages)).toHaveLength(6);
    expect(lastCheckpoint(pages).since).toBeUndefined();
  });
});

// A team inbox (#581): the first backfill reads the mailbox that answers as the registered address, or reads nothing.
describe('the Gmail reader: a team inbox answers as its registered address (#581)', () => {
  const TEAM = 'deals@bank.example';
  const TEAM_ID = '44444444-4444-4444-8444-444444444444';
  const oneThread: FakeThread[] = [{ id: 't1', messages: [{ id: 'm1', internalDate: 1000 }] }];
  const asTeam = (gmail: ReturnType<typeof fakeGmail>) => ({ ...gmail.source, ownerUserId: null, teamMailboxId: TEAM_ID });
  const drainTeam = async (gmail: ReturnType<typeof fakeGmail>, source = asTeam(gmail), checkpoint: string | null = null) => {
    const reader = createGmailMailContentSource({ httpFor: async () => gmail.http, exclusion: NO_EXCLUSION });
    const pages: SourceItemPage[] = [];
    for await (const page of reader.backfill(source, checkpoint)) pages.push(page);
    return pages;
  };

  it('reads a team inbox whose profile is its address, whatever the case', async () => {
    const gmail = fakeGmail({ address: TEAM, threads: oneThread });
    const pages = await drainTeam(gmail, { ...asTeam(gmail), address: 'Deals@Bank.Example ' });
    expect(idsOf(pages)).toEqual(['m1']);
    expect(gmail.log[0]).toBe('profile');
  });

  it.each([
    ['another account', { emailAddress: 'someone.else@bank.example', historyId: '1000' }],
    ['no address at all', { historyId: '1000' }],
    ['an empty address', { emailAddress: '', historyId: '1000' }],
  ])('refuses before the first listing when the profile is %s, and says nothing of either address', async (_name, body) => {
    const gmail = fakeGmail({
      address: TEAM,
      threads: oneThread,
      inject: ({ path }) => (path === '/profile' ? { status: 200, body } : undefined),
    });
    const error = await drainTeam(gmail).catch((e: unknown) => e);
    expect((error as Error).message).toBe('gmail reader: team mailbox profile does not match the registered address');
    expect((error as Error).message).not.toContain('@');
    expect(gmail.log).toEqual(['profile']);
  });

  it("leaves a person's mailbox unchecked: its profile may say anything", async () => {
    const gmail = fakeGmail({
      address: ADDRESS,
      threads: oneThread,
      inject: ({ path }) => (path === '/profile' ? { status: 200, body: { emailAddress: 'alias@bank.example', historyId: '1000' } } : undefined),
    });
    expect(idsOf(await drain(gmail))).toEqual(['m1']);
  });

  it('asks the profile once at the start of a resumed backfill pass (audit item 11), never per page', async () => {
    const gmail = fakeGmail({ address: TEAM, threads: oneThread });
    // A backfill that has already pinned its start history id (a pass before this one asked the profile).
    const resumeAt = serializeCheckpoint({ ...parseCheckpoint(null), startHistoryId: '1000' });
    const pages = await drainTeam(gmail, asTeam(gmail), resumeAt);
    expect(idsOf(pages)).toEqual(['m1']);
    expect(gmail.log.filter((entry) => entry === 'profile')).toEqual(['profile']);
    expect(gmail.log[0]).toBe('profile');
  });

  it('refuses a resumed backfill pass whose profile is another account, before any listing', async () => {
    const gmail = fakeGmail({
      address: TEAM,
      threads: oneThread,
      inject: ({ path }) => (path === '/profile' ? { status: 200, body: { emailAddress: 'someone.else@bank.example' } } : undefined),
    });
    const resumeAt = serializeCheckpoint({ ...parseCheckpoint(null), startHistoryId: '1000' });
    const error = await drainTeam(gmail, asTeam(gmail), resumeAt).catch((e: unknown) => e);
    expect((error as Error).message).toBe('gmail reader: team mailbox profile does not match the registered address');
    expect(gmail.log).toEqual(['profile']);
  });

  // Audit item 11: a delta pass checks too, so an address moved to another account is caught on its next pass.
  const drainTeamDelta = async (gmail: ReturnType<typeof fakeGmail>, checkpoint: string) => {
    const reader = createGmailMailContentSource({ httpFor: async () => gmail.http, exclusion: NO_EXCLUSION });
    const pages: SourceItemPage[] = [];
    for await (const page of reader.delta(asTeam(gmail), checkpoint)) pages.push(page);
    return pages;
  };

  it('asks the profile first on every delta pass of a team inbox, then reads the history', async () => {
    const gmail = fakeGmail({
      address: TEAM,
      threads: [{ id: 't1', messages: [{ id: 'new1', internalDate: 1001 }] }],
      history: { pages: [[added('1001', 'new1')]], current: '1001', validStart: '1000' },
    });
    const pages = await drainTeamDelta(gmail, deltaAt('1000'));
    expect(idsOf(pages)).toEqual(['new1']);
    expect(gmail.log[0]).toBe('profile');
    expect(gmail.log.filter((entry) => entry === 'profile')).toHaveLength(1);
    // The same request a backfill makes, so a recorded replay of the mailbox serves it.
    expect(gmail.urls.filter((url) => url.includes('/profile'))).toEqual([expect.stringMatching(/\/profile$/)]);
  });

  it('refuses a delta pass of a team inbox whose profile is another account, before the history is read', async () => {
    const gmail = fakeGmail({
      address: TEAM,
      threads: [],
      history: { pages: [[added('1001', 'new1')]], current: '1001', validStart: '1000' },
      inject: ({ path }) => (path === '/profile' ? { status: 200, body: { emailAddress: 'someone.else@bank.example' } } : undefined),
    });
    const error = await drainTeamDelta(gmail, deltaAt('1000')).catch((e: unknown) => e);
    expect((error as Error).message).toBe('gmail reader: team mailbox profile does not match the registered address');
    expect((error as Error).message).not.toContain('@');
    expect(gmail.log).toEqual(['profile']);
  });

  it("asks no profile on a person's delta pass, as before", async () => {
    const gmail = fakeGmail({ address: ADDRESS, threads: [], history: { pages: [], current: '1000', validStart: '1000' } });
    await drainDelta(gmail, deltaAt('1000'));
    expect(gmail.log).not.toContain('profile');
  });
});
