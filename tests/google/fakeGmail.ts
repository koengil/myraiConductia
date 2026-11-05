import { buildRfc822 } from '../../scripts/google/lib/rfc822';
import type { SeedAddress } from '../../scripts/google/lib/seedFormat';
import type { GoogleHttpOptions } from '@/lib/google/reader/http';
import type { SourceRow } from '@/lib/discovery/source/types';
import { MAILBOX_PROVIDER, SOURCE_KIND } from '@/lib/constants/discovery';
import {
  GMAIL_HISTORY_FIELDS,
  GMAIL_LABELS_FIELDS,
  GMAIL_MESSAGE_FIELDS,
  GMAIL_METADATA_HEADERS,
  GMAIL_THREAD_LIST_FIELDS,
} from '@/lib/constants/googleReader';

/** A message in the fake mailbox. `raw` overrides the MIME built from the fields. */
export type FakeMessage = {
  id: string;
  messageId?: string;
  labels?: string[];
  /** What the raw answer says the labels are, when a label changed since the metadata read (the label race, R10). Default: `labels`. */
  rawLabels?: string[];
  /** Workspace classification label values in the metadata answer, as Gmail's classificationLabelValues. */
  classification?: Array<{ labelId: string; fields?: Array<{ fieldId: string; selection: string }> }>;
  /** epoch ms; also the Date header unless `date` is given */
  internalDate?: number;
  date?: string;
  from?: SeedAddress;
  to?: SeedAddress[];
  cc?: SeedAddress[];
  subject?: string;
  inReplyTo?: string;
  references?: string[];
  /** Extra headers of the message (the raw always; a metadata answer only when requested): the markers, or Bcc and the like. */
  headers?: Record<string, string>;
  body?: { contentType: 'html' | 'text'; content: string };
  raw?: string;
};
export type FakeThread = { id: string; messages: FakeMessage[] };

/** One history.list record, as Gmail returns it. A message with no threadId is given its thread's, as Gmail does. */
export type FakeHistoryRecord = {
  id: string;
  messagesAdded?: Array<{ message: { id: string; threadId?: string } }>;
  labelsRemoved?: Array<{ message: { id: string; threadId?: string }; labelIds: string[] }>;
};
/** A reply that replaces the fake's own answer to one request. */
export type FakeInjection = { status: number; body?: unknown };

const b64url = (bytes: Uint8Array | string) => Buffer.from(bytes).toString('base64url');

function rawOf(m: FakeMessage): string {
  if (m.raw !== undefined) return m.raw;
  const date = m.date ?? new Date(m.internalDate ?? 0).toISOString();
  return b64url(
    buildRfc822({
      messageId: m.messageId ?? `<${m.id}@bank.example>`,
      date,
      from: m.from ?? { name: 'Storm Duncan', address: 'storm.duncan@bank.example' },
      to: m.to ?? [{ address: 'morgan.vale@bank.example' }],
      cc: m.cc ?? [],
      subject: m.subject ?? `Subject ${m.id}`,
      inReplyTo: m.inReplyTo,
      references: m.references,
      headers: m.headers,
      body: m.body ?? { contentType: 'text', content: `Body of ${m.id}` },
      mailboxes: [],
    }),
  );
}

const fmt = (a: SeedAddress) => (a.name ? `"${a.name}" <${a.address}>` : a.address);

/** Every header the fake message has; a metadata answer passes through `requestedHeaders` first. */
function headersOf(m: FakeMessage): Array<{ name: string; value: string }> {
  const out = [
    { name: 'From', value: fmt(m.from ?? { name: 'Storm Duncan', address: 'storm.duncan@bank.example' }) },
    { name: 'To', value: (m.to ?? [{ address: 'morgan.vale@bank.example' }]).map(fmt).join(', ') },
  ];
  if (m.cc && m.cc.length > 0) out.push({ name: 'Cc', value: m.cc.map(fmt).join(', ') });
  out.push({ name: 'Subject', value: m.subject ?? `Subject ${m.id}` }, { name: 'Message-ID', value: m.messageId ?? `<${m.id}@bank.example>` });
  for (const [name, value] of Object.entries(m.headers ?? {})) out.push({ name, value });
  return out;
}

/**
 * Gmail's metadataHeaders: "only include headers specified", matched case-insensitively. The fake reads the
 * request, not the constant, so a test sees exactly what the reader's URL would get back.
 */
function requestedHeaders(url: URL, m: FakeMessage): Array<{ name: string; value: string }> {
  const requested = new Set(url.searchParams.getAll('metadataHeaders').map((h) => h.toLowerCase()));
  return headersOf(m).filter((h) => requested.has(h.name.toLowerCase()));
}

/**
 * The reader must send its `fields` masks (#263): no snippet before the policy has run. The fake
 * answers 400 to a listing or metadata call that lacks them, so a regression fails the test that makes it.
 */
function maskFault(url: URL, path: string): string | null {
  const fields = url.searchParams.get('fields');
  const want = (expected: string) => (fields === expected ? null : `fields mask missing on ${path}`);
  if (path === '/threads') return want(GMAIL_THREAD_LIST_FIELDS);
  if (path === '/history') return want(GMAIL_HISTORY_FIELDS);
  if (path === '/labels') return want(GMAIL_LABELS_FIELDS);
  if (/^\/threads\/[^/]+$/.test(path)) return want(`id,historyId,messages(${GMAIL_MESSAGE_FIELDS})`);
  if (/^\/messages\/[^/]+$/.test(path) && url.searchParams.get('format') === 'metadata') {
    const headers = url.searchParams.getAll('metadataHeaders');
    if (headers.join(',') !== GMAIL_METADATA_HEADERS.join(',')) return `metadata headers differ on ${path}`;
    return want(GMAIL_MESSAGE_FIELDS);
  }
  return null;
}

/**
 * A scripted Gmail: profile, threads.list (paged), threads.get(metadata),
 * messages.get (raw and metadata) and history.list for one mailbox. `log` names
 * every request in order ("profile", "labels", "list", "list:<pageToken>", "thread:<id>",
 * "raw:<id>", "meta:<id>", "history:<start>", "history:<start>:<pageToken>"), so
 * a test can assert exactly what the reader asked for and in what order. (The reader
 * reads a thread with threads.get on both paths, so a "meta:<id>" is a request it no
 * longer makes; the fake still answers one.)
 */
export function fakeGmail(options: {
  address: string;
  historyId?: string;
  threads: FakeThread[];
  /** labels.list: the mailbox's labels (id and name). Absent: the fake answers 404, so a request nobody expected fails. */
  labels?: Array<{ id: string; name: string }>;
  /** threads per list page; default: all on one page */
  listPageSize?: number;
  /**
   * history.list: one array of records per page (tokens h1, h2, ...), the id
   * the response reports as the mailbox's current record, and the only start
   * id Gmail still holds (any other answers 404).
   */
  history?: { pages: FakeHistoryRecord[][]; current?: string; validStart?: string };
  /** Replaces the answer to a request: `path` is after /users/{address} ("/threads", "/history", "/messages/<id>"). */
  inject?: (request: { path: string; url: URL }) => FakeInjection | undefined;
  /** The source row's backfill_since (#353); absent leaves the source as it always was. */
  backfillSince?: string | null;
}) {
  const log: string[] = [];
  /** Every request's full URL, in order: what the reader asked for, byte for byte. */
  const urls: string[] = [];
  const historyId = options.historyId ?? '1000';
  const pageSize = options.listPageSize ?? Math.max(options.threads.length, 1);
  const user = encodeURIComponent(options.address.toLowerCase());
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  const threadOfMessage = (id: string) => options.threads.find((t) => t.messages.some((m) => m.id === id))?.id;
  const withThreadId = <T extends { id: string; threadId?: string }>(message: T): T => {
    const threadId = message.threadId ?? threadOfMessage(message.id);
    return threadId === undefined ? message : { ...message, threadId };
  };
  const withThreadIds = (record: FakeHistoryRecord): FakeHistoryRecord => ({
    ...record,
    ...(record.messagesAdded ? { messagesAdded: record.messagesAdded.map((entry) => ({ ...entry, message: withThreadId(entry.message) })) } : {}),
    ...(record.labelsRemoved ? { labelsRemoved: record.labelsRemoved.map((entry) => ({ ...entry, message: withThreadId(entry.message) })) } : {}),
  });

  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    urls.push(String(input));
    if (url.origin !== 'https://gmail.googleapis.com') return json({ error: { code: 400 } }, 400);
    const path = url.pathname.replace(`/gmail/v1/users/${user}`, '').replace(
      `/gmail/v1/users/${options.address.toLowerCase()}`,
      '',
    );
    const decoded = decodeURIComponent(url.pathname);
    if (!decoded.startsWith(`/gmail/v1/users/${options.address.toLowerCase()}`)) {
      return json({ error: { code: 404 } }, 404);
    }
    const fault = maskFault(url, path);
    if (fault) return json({ error: { code: 400, message: fault, errors: [{ reason: 'badRequest' }] } }, 400);
    const injected = options.inject?.({ path, url });
    if (injected) {
      // Every kind of request is logged as its own name before the injected answer is returned.
      const message = /^\/messages\/([^/]+)$/.exec(path);
      const threadGet = /^\/threads\/([^/]+)$/.exec(path);
      if (path === '/threads') log.push(url.searchParams.get('pageToken') ? `list:${url.searchParams.get('pageToken')}` : 'list');
      else if (threadGet) log.push(`thread:${decodeURIComponent(threadGet[1])}`);
      else if (path === '/history') {
        const token = url.searchParams.get('pageToken');
        log.push(`history:${url.searchParams.get('startHistoryId')}${token ? `:${token}` : ''}`);
      } else if (message) log.push(`${url.searchParams.get('format') === 'raw' ? 'raw' : 'meta'}:${decodeURIComponent(message[1])}`);
      else if (path === '/profile') log.push('profile');
      return json(injected.body ?? { error: { code: injected.status, errors: [{ reason: 'injected' }] } }, injected.status);
    }
    if (path === '/history') {
      const start = url.searchParams.get('startHistoryId');
      const token = url.searchParams.get('pageToken');
      log.push(`history:${start}${token ? `:${token}` : ''}`);
      const history = options.history ?? { pages: [] };
      if (history.validStart !== undefined && start !== history.validStart) return json({ error: { code: 404, errors: [{ reason: 'notFound' }] } }, 404);
      const page = token ? Number(token.replace('h', '')) : 0;
      const records = (history.pages[page] ?? []).map(withThreadIds);
      const more = page + 1 < history.pages.length;
      return json({
        ...(records.length > 0 ? { history: records } : {}),
        ...(more ? { nextPageToken: `h${page + 1}` } : {}),
        historyId: history.current ?? '2000',
      });
    }
    if (path === '/labels') {
      log.push('labels');
      if (!options.labels) return json({ error: { code: 404 } }, 404);
      return json({ labels: options.labels });
    }
    if (path === '/profile') {
      log.push('profile');
      return json({ emailAddress: options.address, historyId });
    }
    if (path === '/threads') {
      const token = url.searchParams.get('pageToken');
      log.push(token ? `list:${token}` : 'list');
      const listed = listedThreads(options.threads, url.searchParams.get('q'));
      if (listed === null) return json({ error: { code: 400, message: 'unsupported q', errors: [{ reason: 'invalidArgument' }] } }, 400);
      const page = token ? Number(token.replace('p', '')) : 0;
      const slice = listed.slice(page * pageSize, (page + 1) * pageSize);
      const more = (page + 1) * pageSize < listed.length;
      return json({ threads: slice.map((t) => ({ id: t.id })), ...(more ? { nextPageToken: `p${page + 1}` } : {}) });
    }
    const thread = /^\/threads\/([^/]+)$/.exec(path);
    if (thread) {
      const id = decodeURIComponent(thread[1]);
      log.push(`thread:${id}`);
      const found = options.threads.find((t) => t.id === id);
      if (!found) return json({ error: { code: 404 } }, 404);
      return json({
        id,
        messages: found.messages.map((m) => ({
          id: m.id,
          threadId: id,
          labelIds: m.labels ?? ['INBOX'],
          internalDate: String(m.internalDate ?? 0),
          payload: { headers: requestedHeaders(url, m) },
          ...(m.classification ? { classificationLabelValues: m.classification } : {}),
        })),
      });
    }
    const message = /^\/messages\/([^/]+)$/.exec(path);
    if (message) {
      const id = decodeURIComponent(message[1]);
      const format = url.searchParams.get('format');
      log.push(`${format === 'raw' ? 'raw' : 'meta'}:${id}`);
      const owner = options.threads.find((t) => t.messages.some((m) => m.id === id));
      const found = owner?.messages.find((m) => m.id === id);
      if (!owner || !found) return json({ error: { code: 404 } }, 404);
      if (format === 'metadata') {
        return json({
          id,
          threadId: owner.id,
          labelIds: found.labels ?? ['INBOX'],
          internalDate: String(found.internalDate ?? 0),
          payload: { headers: requestedHeaders(url, found) },
          ...(found.classification ? { classificationLabelValues: found.classification } : {}),
        });
      }
      if (format !== 'raw') return json({ error: { code: 400 } }, 400);
      return json({ id, labelIds: found.rawLabels ?? found.labels ?? ['INBOX'], internalDate: String(found.internalDate ?? 0), raw: rawOf(found) });
    }
    return json({ error: { code: 404 } }, 404);
  }) as typeof fetch;

  const http: GoogleHttpOptions = { getToken: async () => 'token', fetchImpl, sleep: async () => undefined, maxAttempts: 1 };
  const source: SourceRow = {
    id: '33333333-3333-4333-8333-333333333333',
    tenantId: '11111111-1111-4111-8111-111111111111',
    kind: SOURCE_KIND.MAILBOX,
    provider: MAILBOX_PROVIDER.GOOGLE,
    address: options.address,
    ownerUserId: '22222222-2222-4222-8222-222222222222',
    deltaCheckpoint: null,
    ...(options.backfillSince !== undefined ? { backfillSince: options.backfillSince } : {}),
  };
  return { fetchImpl, http, log, urls, source, historyId };
}

/**
 * threads.list's `q`, as far as the reader uses it: none lists every thread, and `after:<epoch seconds>` lists a
 * thread if any of its messages is after that instant (Gmail: "if any message in a thread matches the query, the
 * thread is returned"). Exclusive here, the stricter reading of an undocumented boundary. Anything else is null (400),
 * so a query the fake does not model fails the test that sends it.
 */
function listedThreads(threads: FakeThread[], q: string | null): FakeThread[] | null {
  if (q === null) return threads;
  const after = /^after:(\d+)$/.exec(q);
  if (!after) return null;
  const afterMs = Number(after[1]) * 1000;
  return threads.filter((t) => t.messages.some((m) => (m.internalDate ?? 0) > afterMs));
}

/** n messages in one thread, oldest first, ids `${prefix}1..n`. */
export function threadOf(id: string, n: number, prefix = `${id}-m`): FakeThread {
  return {
    id,
    messages: Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i + 1}`, internalDate: 1_700_000_000_000 + i * 60_000 })),
  };
}
