// @vitest-environment node
import { describe, expect, it } from 'vitest';

import type { GraphHttpOptions } from '@/lib/graph/http';
import type { SourceItemPage, SourceRow } from '@/lib/graph/reader';
import {
  assertCheckpointKey,
  checkBinding,
  createGraphMailContentSource,
  parseMailCheckpoint,
  type MailCheckpoint,
} from '@/lib/graph/reader/mail';
import { readerCapability } from './readerCapability';
import { runSyncJobs, SYNC_MAX_PAGES, type SourceDbState } from './syncJobs';

/*
 * The live mailbox reader over a stubbed Graph (no network): folder listing,
 * per-folder messages delta, and the checkpoint after every page. The point
 * of the checkpoint is that a restart resumes: reading from a stored
 * checkpoint must never ask Graph for a page that was already served.
 */

const G = 'https://graph.microsoft.com/v1.0';
const BOX = `${G}/users/storm.duncan%40bank.example`;
const SELECT =
  '$select=id,internetMessageId,conversationId,subject,sentDateTime,receivedDateTime,from,toRecipients,ccRecipients,body,hasAttachments';
const deltaStart = (folder: string) => `${BOX}/mailFolders/${folder}/messages/delta?${SELECT}`;

function message(id: string, subject: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    internetMessageId: `<${id}@bank.example>`,
    conversationId: `conv-${id}`,
    subject,
    sentDateTime: '2026-02-03T09:00:00Z',
    from: { emailAddress: { address: 'storm.duncan@bank.example', name: 'Storm Duncan' } },
    toRecipients: [{ emailAddress: { address: 'dana@heliotrope.example' } }],
    ccRecipients: [],
    body: { contentType: 'text', content: subject },
    ...extra,
  };
}

/** A tiny Graph: every URL it knows, and a log of what was asked. */
function fakeGraph(options: { newFolder?: boolean } = {}) {
  const routes = new Map<string, unknown>([
    [`${BOX}/mailFolders/deleteditems?$select=id`, { id: 'F-DEL' }],
    [`${BOX}/mailFolders/drafts?$select=id`, { id: 'F-DRAFTS' }],
    [
      `${BOX}/mailFolders?$select=id,childFolderCount&$top=100`,
      {
        value: [
          { id: 'F-IN', childFolderCount: 1 },
          { id: 'F-DEL', childFolderCount: 0 },
          { id: 'F-SENT', childFolderCount: 0 },
          { id: 'F-DRAFTS', childFolderCount: 0 },
          ...(options.newFolder ? [{ id: 'F-NEW', childFolderCount: 0 }] : []),
        ],
      },
    ],
    [`${BOX}/mailFolders/F-IN/childFolders?$select=id,childFolderCount&$top=100`, { value: [{ id: 'F-DEALS', childFolderCount: 0 }] }],
    [
      deltaStart('F-IN'),
      { value: [message('in-1', 'Project Falcon: kickoff'), message('in-2', 'Lunch?')], '@odata.nextLink': `${G}/in?$skiptoken=2` },
    ],
    [`${G}/in?$skiptoken=2`, { value: [message('in-3', 'RE: Project Falcon: kickoff')], '@odata.deltaLink': `${G}/in?$deltatoken=d1` }],
    [deltaStart('F-DEALS'), { value: [message('deal-1', 'Project Cobra: engagement letter')], '@odata.deltaLink': `${G}/deals?$deltatoken=d1` }],
    [
      deltaStart('F-SENT'),
      {
        value: [
          message('sent-1', 'Project Falcon timeline'),
          { id: 'gone-1', '@removed': { reason: 'deleted' } },
          message('draft-like', 'No message id', { internetMessageId: null }),
          message('blank-id', 'Blank message id', { internetMessageId: '   ' }),
          message('drive-shaped', 'Id shaped like a document key', { internetMessageId: 'drive:D1:f-cim' }),
        ],
        '@odata.deltaLink': `${G}/sent?$deltatoken=d1`,
      },
    ],
    // Incremental reads.
    [`${G}/in?$deltatoken=d1`, { value: [message('in-4', 'Project Falcon: buyer list')], '@odata.deltaLink': `${G}/in?$deltatoken=d2` }],
    [`${G}/deals?$deltatoken=d1`, { value: [], '@odata.deltaLink': `${G}/deals?$deltatoken=d1` }],
    [`${G}/sent?$deltatoken=d1`, { value: [], '@odata.deltaLink': `${G}/sent?$deltatoken=d1` }],
    [deltaStart('F-NEW'), { value: [message('new-1', 'Project Heron')], '@odata.deltaLink': `${G}/new?$deltatoken=d1` }],
  ]);
  const requests: Array<{ url: string; prefer: string | null }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, prefer: new Headers(init?.headers).get('Prefer') });
    if (!routes.has(url)) {
      return new Response(JSON.stringify({ error: { code: 'ErrorItemNotFound' } }), { status: 404 });
    }
    return new Response(JSON.stringify(routes.get(url)), { status: 200 });
  }) as typeof fetch;
  const http: GraphHttpOptions = { getToken: async () => 'token', fetchImpl, sleep: async () => undefined };
  return { http, requests, reads: () => requests.map((r) => r.url).filter((u) => u.includes('delta') || /\/(in|deals|sent|new)\?/.test(u)) };
}

const SOURCE: SourceRow = {
  id: 'src-1',
  tenantId: 't-1',
  kind: 'mailbox',
  provider: 'microsoft',
  address: 'storm.duncan@bank.example',
  ownerUserId: 'u-1',
  deltaCheckpoint: null,
};

async function collect(pages: AsyncIterable<SourceItemPage>, stopAfter = Infinity) {
  const out: SourceItemPage[] = [];
  for await (const page of pages) {
    out.push(page);
    if (out.length >= stopAfter) break;
  }
  return out;
}

describe('graph mail reader', () => {
  it('backfills every folder but the excluded ones, checkpointing after every page', async () => {
    const graph = fakeGraph();
    const reader = createGraphMailContentSource(readerCapability, { http: graph.http });
    const pages = await collect(reader.backfill(SOURCE, null));

    // The folder list first, then two Inbox pages, Sent, then the Inbox
    // subfolder (folders are listed breadth first).
    expect(pages.map((p) => p.items.map((m) => m.id))).toEqual([[], ['in-1', 'in-2'], ['in-3'], ['sent-1'], ['deal-1']]);
    const first = parseMailCheckpoint(pages[0].nextCheckpoint!);
    expect(first.folders.map((f) => f.id)).toEqual(['F-IN', 'F-SENT', 'F-DEALS']);
    expect(first.folders.every((f) => f.link === null && !f.done)).toBe(true);

    const last = parseMailCheckpoint(pages.at(-1)!.nextCheckpoint!);
    expect(last.folders).toEqual([
      { id: 'F-IN', link: `${G}/in?$deltatoken=d1`, done: true },
      { id: 'F-SENT', link: `${G}/sent?$deltatoken=d1`, done: true },
      { id: 'F-DEALS', link: `${G}/deals?$deltatoken=d1`, done: true },
    ]);

    // A deleted item, a message without an id, a blank id and an id shaped
    // like a document key are all dropped from the Sent page above.

    // Deleted items and drafts are never read; immutable ids are asked for.
    expect(graph.reads().some((u) => u.includes('F-DEL/') || u.includes('F-DRAFTS/'))).toBe(false);
    expect(graph.requests.find((r) => r.url === deltaStart('F-IN'))?.prefer).toBe(
      'odata.maxpagesize=50, IdType="ImmutableId"',
    );
    expect(pages[1].items[0]).toMatchObject({
      internetMessageId: '<in-1@bank.example>',
      from: { emailAddress: { address: 'storm.duncan@bank.example' } },
    });
  });

  it('resumes from a stored checkpoint without re-reading a page', async () => {
    const first = fakeGraph();
    const pagesBeforeKill = await collect(createGraphMailContentSource(readerCapability, { http: first.http }).backfill(SOURCE, null), 2);
    const stored = pagesBeforeKill.at(-1)!.nextCheckpoint!;
    expect(parseMailCheckpoint(stored).folders[0]).toEqual({ id: 'F-IN', link: `${G}/in?$skiptoken=2`, done: false });

    const restart = fakeGraph();
    const resumed = await collect(createGraphMailContentSource(readerCapability, { http: restart.http }).backfill(SOURCE, stored));
    expect(resumed.map((p) => p.items.map((m) => m.id))).toEqual([['in-3'], ['sent-1'], ['deal-1']]);
    // No folder listing and no Inbox page 1 on the restart.
    expect(restart.requests.map((r) => r.url)).toEqual([
      `${G}/in?$skiptoken=2`,
      deltaStart('F-SENT'),
      deltaStart('F-DEALS'),
    ]);
  });

  it('reads only what changed from the delta links, and starts a new folder from scratch', async () => {
    const backfill = await collect(createGraphMailContentSource(readerCapability, { http: fakeGraph().http }).backfill(SOURCE, null));
    const token = backfill.at(-1)!.nextCheckpoint!;

    const graph = fakeGraph({ newFolder: true });
    const pages = await collect(createGraphMailContentSource(readerCapability, { http: graph.http }).delta(SOURCE, token));
    expect(pages.flatMap((p) => p.items.map((m) => m.id))).toEqual(['in-4', 'new-1']);
    expect(graph.reads()).toEqual([
      `${G}/in?$deltatoken=d1`,
      `${G}/sent?$deltatoken=d1`,
      deltaStart('F-NEW'),
      `${G}/deals?$deltatoken=d1`,
    ]);
    const next = parseMailCheckpoint(pages.at(-1)!.nextCheckpoint!) as MailCheckpoint;
    expect(next.folders.find((f) => f.id === 'F-IN')).toEqual({ id: 'F-IN', link: `${G}/in?$deltatoken=d2`, done: true });
  });

  it('refuses a checkpoint it did not write', () => {
    expect(() => parseMailCheckpoint('fixture:4')).toThrow('not JSON');
    expect(() => parseMailCheckpoint('{"v":1,"kind":"graph-drive","folders":[]}')).toThrow('not a graph-mail checkpoint');
  });

  it('surfaces a 403 for a mailbox outside the application access scope', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { code: 'ErrorAccessDenied' } }), { status: 403 })) as typeof fetch;
    const reader = createGraphMailContentSource(readerCapability, { http: { getToken: async () => 't', fetchImpl } });
    await expect(collect(reader.backfill(SOURCE, null))).rejects.toMatchObject({ status: 403, code: 'ErrorAccessDenied' });
  });
});

describe('graph mail reader across the worker page limit', () => {
  // More folders than one job reads: every delta job used to reset every
  // folder to unread, so each continuation re-read the first SYNC_MAX_PAGES
  // folders and the last one was never reached.
  const FOLDERS = Array.from({ length: SYNC_MAX_PAGES + 1 }, (_, i) => `F-${i}`);

  function manyFolders() {
    const requested: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      if (url === `${BOX}/mailFolders?$select=id,childFolderCount&$top=100`) {
        return Response.json({ value: FOLDERS.map((id) => ({ id, childFolderCount: 0 })) });
      }
      const start = /\/mailFolders\/(F-\d+)\/messages\/delta\?/.exec(url);
      if (start) return Response.json({ value: [], '@odata.deltaLink': `${G}/${start[1]}?$deltatoken=d1` });
      const delta = /\/(F-\d+)\?\$deltatoken=(d\d)$/.exec(url);
      if (delta) {
        const [, folder, token] = delta;
        // One change per folder after the backfill, then nothing.
        const value = token === 'd1' ? [message(`${folder}-changed`, 'Lunch?')] : [];
        return Response.json({ value, '@odata.deltaLink': `${G}/${folder}?$deltatoken=d2` });
      }
      return new Response(JSON.stringify({ error: { code: 'ErrorItemNotFound' } }), { status: 404 });
    }) as typeof fetch;
    return { http: { getToken: async () => 'token', fetchImpl, sleep: async () => undefined } as GraphHttpOptions, requested };
  }

  it('finishes a delta cycle over more folders than one job reads, then starts the next from the new links', async () => {
    const graph = manyFolders();
    const reader = createGraphMailContentSource(readerCapability, { http: graph.http });
    const row: SourceDbState = { delta_checkpoint: null, backfill_completed_at: null };

    const backfill = await runSyncJobs(reader, SOURCE, row);
    expect(backfill.map((j) => [j.mode, j.status])).toEqual([
      ['backfill', 'page_limit'],
      ['backfill', 'complete'],
    ]);
    expect(row.backfill_completed_at).not.toBeNull();

    // The next tick: two jobs, every folder's change read exactly once.
    graph.requested.length = 0;
    const cycle = await runSyncJobs(reader, SOURCE, row);
    expect(cycle.map((j) => [j.mode, j.status])).toEqual([
      ['delta', 'page_limit'],
      ['delta', 'complete'],
    ]);
    expect(cycle.reduce((sum, j) => sum + j.itemsRead, 0)).toBe(FOLDERS.length);
    const reads = graph.requested.filter((u) => u.includes('$deltatoken='));
    expect(reads.filter((u) => u.endsWith('d1'))).toHaveLength(FOLDERS.length);
    expect(reads.filter((u) => u.endsWith('d2'))).toHaveLength(0);
    const done = parseMailCheckpoint(row.delta_checkpoint!);
    expect(done.cycle).toBe('complete');
    expect(done.folders.every((f) => f.done && f.link?.endsWith('d2'))).toBe(true);

    // The tick after that starts a new cycle from every folder's new link.
    graph.requested.length = 0;
    const next = await runSyncJobs(reader, SOURCE, row);
    expect(next.map((j) => j.status)).toEqual(['page_limit', 'complete']);
    expect(graph.requested.filter((u) => u.endsWith('$deltatoken=d2'))).toHaveLength(FOLDERS.length);
  });
});

describe('graph mail reader: the pass record count (#370)', () => {
  it('counts every delta object that is not a removal as fetched, kept or not; the folder-list page counts none', async () => {
    const graph = fakeGraph();
    const reader = createGraphMailContentSource(readerCapability, { http: graph.http });
    const pages = await collect(reader.backfill(SOURCE, null));
    // Sent: sent-1, the message with no id, the blank id and the drive-shaped id crossed the wire (bodies are
    // $select'ed); the removed item did not.
    expect(pages.map((p) => p.fetched ?? 0)).toEqual([0, 2, 1, 4, 1]);
    expect(pages[3].items.map((m) => m.id)).toEqual(['sent-1']);
  });
});

/*
 * #275 design R4: before the first page of a live mailbox read, the bound member's inbox is read by its object id and
 * by its UPN, and the two must be one folder. A resume follows the links its checkpoint stored, so those must address
 * the same bound object.
 */
describe('the binding check (#275)', () => {
  const KEY = { upn: 'deals@bankexample.onmicrosoft.com', id: '00000000-0000-4000-8000-000000000190' };
  const byId = `${G}/users/${KEY.id}/mailFolders/inbox?$select=id`;
  const byUpn = `${G}/users/deals%40bankexample.onmicrosoft.com/mailFolders/inbox?$select=id`;

  /** Answers each inbox request with the given status and folder id, and records the request and its headers. */
  function inboxes(answers: Record<string, { status: number; id?: string }>) {
    const requests: Array<{ url: string; headers: Headers }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, headers: new Headers(init?.headers) });
      const answer = answers[url] ?? { status: 404 };
      if (answer.status !== 200) {
        return new Response(JSON.stringify({ error: { code: answer.status === 403 ? 'ErrorAccessDenied' : 'ErrorItemNotFound' } }), {
          status: answer.status,
        });
      }
      return Response.json(answer.id === undefined ? {} : { id: answer.id });
    }) as typeof fetch;
    const http: GraphHttpOptions = { getToken: async () => 'token', fetchImpl, sleep: async () => undefined };
    return { http, requests };
  }

  it('passes when the inbox by object id and by UPN is the same folder, asking by id first, with identical headers', async () => {
    const graph = inboxes({ [byId]: { status: 200, id: 'F-IN' }, [byUpn]: { status: 200, id: 'F-IN' } });
    await expect(checkBinding(readerCapability, graph.http, KEY)).resolves.toBe(true);
    expect(graph.requests.map((r) => r.url)).toEqual([byId, byUpn]);
    // The mail reader's own headers, on both: a folder id depends on IdType.
    const [first, second] = graph.requests.map((r) => Object.fromEntries(r.headers.entries()));
    expect(first).toEqual(second);
    expect(first.prefer).toBe('odata.maxpagesize=50, IdType="ImmutableId"');
    expect(first.authorization).toBe('Bearer token');
  });

  it('refuses when the two reach different folders', async () => {
    const graph = inboxes({ [byId]: { status: 200, id: 'F-IN' }, [byUpn]: { status: 200, id: 'F-OTHER' } });
    await expect(checkBinding(readerCapability, graph.http, KEY)).resolves.toBe(false);
  });

  it.each([
    ['a 403 by object id', { [byId]: { status: 403 } }, 1],
    ['a 404 by object id', { [byId]: { status: 404 } }, 1],
    ['a 403 by UPN', { [byId]: { status: 200, id: 'F-IN' }, [byUpn]: { status: 403 } }, 2],
    ['a 404 by UPN', { [byId]: { status: 200, id: 'F-IN' }, [byUpn]: { status: 404 } }, 2],
    ['an answer without a folder id', { [byId]: { status: 200 }, [byUpn]: { status: 200 } }, 1],
  ] as Array<[string, Record<string, { status: number; id?: string }>, number]>)(
    'refuses on %s, with no request after it',
    async (_label, answers, requests) => {
      const graph = inboxes(answers);
      await expect(checkBinding(readerCapability, graph.http, KEY)).resolves.toBe(false);
      expect(graph.requests).toHaveLength(requests);
    },
  );

  it.each([429, 500, 503, 401, 400])('throws a %s instead of reading it as a failed binding', async (status) => {
    const graph = inboxes({ [byId]: { status } });
    const http: GraphHttpOptions = { ...graph.http, maxAttempts: 1 };
    await expect(checkBinding(readerCapability, http, KEY)).rejects.toMatchObject({ name: 'GraphHttpError', status });
  });

  it('throws a throttled answer on the UPN request too, after the id request passed', async () => {
    const graph = inboxes({ [byId]: { status: 200, id: 'F-IN' }, [byUpn]: { status: 429 } });
    const http: GraphHttpOptions = { ...graph.http, maxAttempts: 1 };
    await expect(checkBinding(readerCapability, http, KEY)).rejects.toMatchObject({ name: 'GraphHttpError', status: 429 });
  });

  it('throws anything that is not a Graph answer, as any read does', async () => {
    const http: GraphHttpOptions = {
      getToken: async () => 'token',
      fetchImpl: (async () => {
        throw new DOMException('The operation timed out.', 'TimeoutError');
      }) as typeof fetch,
      maxAttempts: 1,
    };
    await expect(checkBinding(readerCapability, http, KEY)).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('demands the reader capability', async () => {
    const graph = inboxes({});
    await expect(checkBinding({} as never, graph.http, KEY)).rejects.toMatchObject({ reason: 'no_capability' });
    expect(graph.requests).toEqual([]);
  });
});

describe('the checkpoint key check (#275)', () => {
  const KEY = { upn: 'storm.duncan@bank.example', id: '00000000-0000-4000-8000-000000000101' };
  const checkpoint = (...links: Array<string | null>) =>
    JSON.stringify({ v: 1, kind: 'graph-mail', cycle: 'running', folders: links.map((link, i) => ({ id: `F-${i}`, link, done: false })) });
  const link = (key: string) => `${G}/users/${key}/mailFolders/F-IN/messages/delta?$skiptoken=r2`;

  it('passes no checkpoint, and a checkpoint with no link yet', () => {
    expect(() => assertCheckpointKey(null, KEY)).not.toThrow();
    expect(() => assertCheckpointKey(checkpoint(null, null), KEY)).not.toThrow();
  });

  it.each([
    ['the UPN', link('storm.duncan%40bank.example')],
    ['the UPN in another case', link('Storm.Duncan%40Bank.Example')],
    ['the object id', link(KEY.id)],
    ['the object id in upper case', link(KEY.id.toUpperCase())],
    ["the ('UPN') form", `${G}/users('storm.duncan%40bank.example')/mailFolders('F-IN')/messages/delta?$deltatoken=r3`],
    ["the ('id') form", `${G}/users('${KEY.id}')/mailFolders('F-IN')/messages/delta?$deltatoken=r3`],
  ])('passes links keyed by %s', (_label, stored) => {
    expect(() => assertCheckpointKey(checkpoint(stored, null), KEY)).not.toThrow();
  });

  it.each([
    ['an address that is not the UPN', link('s.duncan%40bank.example')],
    ['another object id', link('00000000-0000-4000-8000-000000000102')],
    ['no user at all', `${G}/me/mailFolders/F-IN/messages/delta?$skiptoken=r2`],
    ['another host', 'https://graph.example/v1.0/users/storm.duncan%40bank.example/mailFolders/F-IN/messages/delta'],
  ])('refuses a link keyed by %s, as an unreadable checkpoint', (_label, stored) => {
    // One good link does not excuse another folder's.
    expect(() => assertCheckpointKey(checkpoint(link(KEY.id), stored), KEY)).toThrow(
      'graph mail reader: the checkpoint addresses another mailbox key',
    );
  });

  it('refuses a malformed checkpoint the way the reader does', () => {
    expect(() => assertCheckpointKey('fixture:4', KEY)).toThrow('graph mail reader: the checkpoint is not JSON');
    expect(() =>
      assertCheckpointKey(JSON.stringify({ v: 1, kind: 'graph-mail', folders: [{ id: 'F-IN', link: 7, done: false }] }), KEY),
    ).toThrow('the checkpoint addresses another mailbox key');
  });
});
