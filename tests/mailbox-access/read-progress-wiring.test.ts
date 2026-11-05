// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Reader liveness (#409): the live Gmail and Graph readers hand every token and successful response to the pass's
// onProgress (withReadProgress). The 900 s window (READER_LIVENESS_SECONDS) rests on that wiring, so each path is
// pinned here with a fake transport: the request fails before any page, so the only marks are the transport's.

const admin = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createSupabaseAdminClient: () => ({ rpc: admin.rpc }) }));

const transport = vi.hoisted(() => ({
  getToken: vi.fn(async () => 'token'),
  // Not found: no retry, no page, so nothing but the transport can mark.
  fetchImpl: vi.fn(async () => new Response('{}', { status: 404 })),
}));
vi.mock('@/lib/google/reader/registration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/google/reader/registration')>();
  return {
    ...actual,
    googleDelegationRecorder: () => () => undefined,
    googleReaderRegistry: () => ({
      httpFor: async () => ({ getToken: transport.getToken, fetchImpl: transport.fetchImpl, clientId: 'client-1' }),
    }),
  };
});
vi.mock('@/lib/graph/reader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/graph/reader')>();
  return {
    ...actual,
    createGraphReaderContext: () => ({ http: { getToken: transport.getToken, fetchImpl: transport.fetchImpl, maxAttempts: 1 } }),
  };
});

import { MAILBOX_PROVIDER, READER_MODE, SOURCE_KIND } from '@/lib/constants/discovery';
import { guardedContentSource, type ContentSource, type SourceRow } from '@/lib/mailboxAccess';

import { exclusionWith } from '../google/exclusion';

const TENANT = '11111111-1111-4111-8111-111111111111';
const row = (provider: 'google' | 'microsoft'): SourceRow => ({
  id: '33333333-3333-4333-8333-333333333333',
  tenantId: TENANT,
  kind: SOURCE_KIND.MAILBOX,
  provider,
  address: 'storm.duncan@bank.example',
  ownerUserId: '22222222-2222-4222-8222-222222222222',
  deltaCheckpoint: null,
});

async function firstPage(reader: ContentSource, source: SourceRow) {
  for await (const page of reader.backfill(source, null)) return page;
  return null;
}

beforeEach(() => {
  admin.rpc.mockReset();
  admin.rpc.mockResolvedValue({ data: null, error: null }); // the guard allows
  transport.getToken.mockClear();
  transport.fetchImpl.mockClear();
});

describe('the live readers mark progress through their transport', () => {
  it('Gmail: a token marks progress, before any page', async () => {
    const onProgress = vi.fn();
    const reader = guardedContentSource({ kind: SOURCE_KIND.MAILBOX, provider: MAILBOX_PROVIDER.GOOGLE }, READER_MODE.LIVE, {
      tenantId: TENANT,
      providerCheck: () => null,
      exclusion: exclusionWith([]),
      onProgress,
    });
    await expect(firstPage(reader, row('google'))).rejects.toThrow();
    expect(transport.getToken).toHaveBeenCalled();
    expect(onProgress).toHaveBeenCalledTimes(transport.getToken.mock.calls.length);
  });

  it('Graph: a token marks progress, before any page', async () => {
    const onProgress = vi.fn();
    const reader = guardedContentSource({ kind: SOURCE_KIND.MAILBOX, provider: MAILBOX_PROVIDER.MICROSOFT }, READER_MODE.LIVE, {
      tenantId: TENANT,
      providerCheck: () => null,
      // The bound mailbox (#275): its binding check is the first request, and the 404 stops the read there.
      readKey: () => ({ upn: 'storm.duncan@bank.example', id: '00000000-0000-4000-8000-000000000103' }),
      graphRegistration: { clientId: 'client-1', certThumbprint: 'AB' } as never,
      onProgress,
    });
    await expect(firstPage(reader, row('microsoft'))).rejects.toThrow();
    expect(transport.getToken).toHaveBeenCalled();
    expect(onProgress).toHaveBeenCalledTimes(transport.getToken.mock.calls.length);
  });
});
