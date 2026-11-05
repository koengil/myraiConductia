// @vitest-environment node
// Content tags at upload (E5b): categories only, never content; never clean
// when unread; tagging never blocks an upload; the list filters by tag.
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

// after() runs the tagging once the response is sent; queued here and
// flushed by the tests (as tests/api-v1-bench-chat-usage.test.ts does).
const afterTasks: Array<() => Promise<unknown>> = [];
vi.mock('next/server', async (original) => ({
  ...(await original<typeof import('next/server')>()),
  after: (task: () => Promise<unknown>) => {
    afterTasks.push(task);
  },
}));
const flushAfter = () => Promise.all(afterTasks.splice(0).map((task) => task()));

vi.mock('@/lib/api/v1/requireFlag', () => ({
  requireFlag: vi.fn(() => Promise.resolve(null)),
  isFlagEnabled: vi.fn(() => Promise.resolve(true)),
}));
vi.mock('@/lib/api/v1/http', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/api/v1/http')>()),
  requireApiUser: vi.fn(),
  resolveDealRef: vi.fn(() => Promise.resolve({ id: 'd1', code: 'PRJRA' })),
}));
vi.mock('@/lib/api/v1/access', () => ({
  userCanAccessDeal: vi.fn(() => Promise.resolve(true)),
}));
vi.mock('@/lib/api/v1/documentAccess', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/api/v1/documentAccess')>()),
  getDocumentViewer: vi.fn(),
}));
vi.mock('@/lib/storage', () => ({ getDataRoomStorage: vi.fn() }));

import { GET as LIST, POST as UPLOAD } from '@/app/api/v1/deals/[dealId]/documents/route';
import { getDocumentViewer, type DocumentViewer } from '@/lib/api/v1/documentAccess';
import { requireApiUser } from '@/lib/api/v1/http';
import { MAX_ATTACHMENT_BYTES } from '@/lib/compliance/attachmentText';
import {
  DOCUMENT_TAG_RULES_VERSION,
  parseDocumentTag,
  storeDocumentContentTags,
  tagDocumentContent,
} from '@/lib/compliance/documentTags';
import { getDataRoomStorage } from '@/lib/storage';

const utf8 = (text: string) => new TextEncoder().encode(text);
const NOW = new Date('2026-10-15T12:00:00Z');

describe('tagDocumentContent', () => {
  it('tags a document read in full with rule kinds and lexicon categories, never its text', async () => {
    const text = 'We guarantee the deal closes. Our floor valuation is $510M. It is 100% safe.';
    const tags = await tagDocumentContent({ name: 'memo.txt', type: 'text/plain', bytes: utf8(text) }, NOW);
    expect(tags).toEqual({
      contentDigest: createHash('sha256').update(text).digest('hex'),
      textStatus: 'ok',
      rulesVersion: DOCUMENT_TAG_RULES_VERSION,
      taggedAt: NOW.toISOString(),
      tags: expect.arrayContaining(['mnpi', 'promissory', 'lexicon-8']),
    });
    const serialized = JSON.stringify(tags).toLowerCase();
    for (const fragment of ['guarantee', 'floor', '510', '100% safe']) {
      expect(serialized).not.toContain(fragment);
    }
  });

  it('a document read in full with no signal carries an empty tag list', async () => {
    const tags = await tagDocumentContent({ name: 'agenda.txt', type: 'text/plain', bytes: utf8('Lunch at noon.') });
    expect(tags.textStatus).toBe('ok');
    expect(tags.tags).toEqual([]);
  });

  it('an unread document carries its status and no tag list, so it is never clean', async () => {
    const tags = await tagDocumentContent({
      name: 'cim.pdf',
      type: 'application/pdf',
      bytes: new Uint8Array([1, 2, 3]),
    });
    expect(tags.textStatus).toBe('unreadable');
    expect(tags).not.toHaveProperty('tags');
  });

  it('a file past the read cap is too_large without being decoded, and keeps its digest', async () => {
    const bytes = new Uint8Array(MAX_ATTACHMENT_BYTES + 1);
    const tags = await tagDocumentContent({ name: 'big.txt', type: 'text/plain', bytes });
    expect(tags.textStatus).toBe('too_large');
    expect(tags).not.toHaveProperty('tags');
    expect(tags.contentDigest).toBe(createHash('sha256').update(bytes).digest('hex'));
  });
});

describe('parseDocumentTag', () => {
  it('accepts only tags the tagger writes', () => {
    expect(parseDocumentTag('MNPI')).toBe('mnpi');
    expect(parseDocumentTag('lexicon-12')).toBe('lexicon-12');
    expect(parseDocumentTag('floor')).toBeNull();
    expect(parseDocumentTag(null)).toBeNull();
  });
});

type Call = { method: string; args: unknown[] };

function makeAdmin(resp: { data: unknown; error: unknown }) {
  const calls: Call[] = [];
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'contains', 'order', 'update']) {
    builder[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return builder;
    };
  }
  builder.then = (onFulfilled: (v: unknown) => unknown) => Promise.resolve(resp).then(onFulfilled);
  const admin = {
    from: vi.fn(() => builder),
    rpc: vi.fn(() => Promise.resolve({ data: { id: 'doc-1', name: 'memo.txt', room: 'deal' }, error: null })),
  };
  return { admin: admin as unknown as SupabaseClient, calls };
}

function signIn(admin: SupabaseClient, viewer: Partial<DocumentViewer> = {}) {
  vi.mocked(requireApiUser).mockResolvedValue({ ok: true, admin, user: { id: 'md' } } as never);
  vi.mocked(getDocumentViewer).mockResolvedValue({
    userId: 'md',
    isExternal: false,
    hasOversight: false,
    dealRole: 'md',
    phase: 0,
    ...viewer,
  });
}

function mockStorage() {
  const remove = vi.fn(() => Promise.resolve());
  vi.mocked(getDataRoomStorage).mockReturnValue({
    provider: 'local',
    upload: vi.fn(() => Promise.resolve({ provider: 'local', fileId: 'f-1', sizeBytes: 3 })),
    downloadStream: vi.fn(),
    remove,
  } as never);
  return remove;
}

function upload(text: string) {
  const form = new FormData();
  form.set('file', new File([text], 'memo.txt', { type: 'text/plain' }));
  form.set('room', 'deal');
  return UPLOAD(new Request('http://localhost/api/v1/deals/d1/documents', { method: 'POST', body: form }), {
    params: Promise.resolve({ dealId: 'd1' }),
  });
}

describe('upload route stores content tags', () => {
  afterEach(() => {
    afterTasks.length = 0;
    vi.clearAllMocks();
  });

  it('answers before tagging, then writes the tags on the new document row', async () => {
    const { admin, calls } = makeAdmin({ data: null, error: null });
    signIn(admin);
    mockStorage();
    const res = await upload('Our floor valuation is $510M.');
    expect(res.status).toBe(201);
    expect(calls.some((c) => c.method === 'update')).toBe(false);
    expect(afterTasks).toHaveLength(1);
    await flushAfter();
    const update = calls.find((c) => c.method === 'update');
    expect(update?.args[0]).toMatchObject({ content_tags: { textStatus: 'ok', tags: ['mnpi'] } });
    expect(calls).toContainEqual({ method: 'eq', args: ['id', 'doc-1'] });
  });

  it('a tag write that fails never fails the upload', async () => {
    const { admin } = makeAdmin({ data: null, error: { message: 'column "content_tags" does not exist' } });
    signIn(admin);
    const remove = mockStorage();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await upload('Our floor valuation is $510M.');
    expect(res.status).toBe(201);
    await flushAfter();
    expect(log).toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain('510');
    log.mockRestore();
  });

  it('storeDocumentContentTags never throws', async () => {
    const admin = { from: () => { throw new Error('down'); } } as unknown as SupabaseClient;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      storeDocumentContentTags(admin, 'doc-1', { name: 'a.txt', type: 'text/plain', bytes: utf8('x') }),
    ).resolves.toBeUndefined();
    log.mockRestore();
  });
});

describe('document list filters by tag', () => {
  afterEach(() => vi.clearAllMocks());

  const row = (id: string, classification: number) => ({
    id,
    name: `${id}.pdf`,
    room: 'deal',
    classification,
    min_phase: 0,
    uploaded_by: 'md',
    created_at: '2026-10-15T12:00:00Z',
    size_bytes: 3,
    content_type: 'application/pdf',
    storage_file_id: 'f',
    folder: null,
    folder_subpath: [],
  });

  const list = (query: string) =>
    LIST(new Request(`http://localhost/api/v1/deals/d1/documents${query}`), {
      params: Promise.resolve({ dealId: 'd1' }),
    });

  it('narrows the query to documents carrying the tag', async () => {
    const { admin, calls } = makeAdmin({ data: [row('a', 2)], error: null });
    signIn(admin);
    const res = await list('?tag=mnpi');
    expect(res.status).toBe(200);
    expect(calls).toContainEqual({ method: 'contains', args: ['content_tags', { tags: ['mnpi'] }] });
  });

  it('does not filter without a tag', async () => {
    const { admin, calls } = makeAdmin({ data: [row('a', 2)], error: null });
    signIn(admin);
    expect((await list('')).status).toBe(200);
    expect(calls.some((c) => c.method === 'contains')).toBe(false);
  });

  it('refuses a value that is not a tag', async () => {
    const { admin } = makeAdmin({ data: [], error: null });
    signIn(admin);
    expect((await list('?tag=floor')).status).toBe(400);
  });

  it('a tag match is listed only to a viewer who may open the document', async () => {
    // The external buyer may list but not open a phase-2 document.
    const { admin } = makeAdmin({
      data: [row('open', 2), { ...row('phase', 2), min_phase: 2 }],
      error: null,
    });
    signIn(admin, { userId: 'b', isExternal: true, dealRole: 'buyer', phase: 0 });
    const tagged = (await (await list('?tag=mnpi')).json()) as { documents: Array<{ id: string }> };
    expect(tagged.documents.map((d) => d.id)).toEqual(['open']);
    const untagged = (await (await list('')).json()) as { documents: Array<{ id: string }> };
    expect(untagged.documents.map((d) => d.id)).toEqual(['open', 'phase']);
  });
});
