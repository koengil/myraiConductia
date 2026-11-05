import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The guard builds its own service client (audit round 1, item 2), so the seam
// is the admin-client module: `admin.rpc` answers for every guard call.
const admin = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseAdminClient: () => ({ rpc: admin.rpc }),
}));

// A live Microsoft read (#275 slice 4) goes to the fake Graph tenant when one is wired: the registration's client is
// still built behind the capability, then its token and transport are swapped for a fixed token and the fake. No
// certificate is used and no token is minted.
const graphWire = vi.hoisted(() => ({ fetch: null as null | typeof fetch, sleeps: 0 }));
vi.mock('@/lib/graph/reader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/graph/reader')>();
  return {
    ...actual,
    createGraphReaderContext: (...args: Parameters<typeof actual.createGraphReaderContext>) => {
      const context = actual.createGraphReaderContext(...args);
      if (!graphWire.fetch) return context;
      return {
        http: {
          getToken: async () => 'fake-token',
          fetchImpl: graphWire.fetch,
          sleep: async () => {
            graphWire.sleeps += 1;
          },
        },
        extract: async (bytes: Uint8Array) => ({ ok: true as const, text: Buffer.from(bytes).toString('latin1') }),
      };
    },
  };
});

import { MAILBOX_PROVIDER, READER_MODE, SOURCE_KIND } from '@/lib/constants/discovery';
import {
  createGuardedContentSource,
  guardedContentSource,
  MailboxAccessRefusedError,
  UnsupportedSourceError,
  type ContentSource,
  type SourceItemPage,
  type SourceRow,
} from '@/lib/mailboxAccess';
import { createGuardedRecording, type GuardedReaderContext, type ResponseObserver } from '@/lib/mailboxAccess/readers';

import { SYNTHETIC_CASSETTE_DIR } from '../../scripts/m365/build-synthetic-cassette';
import {
  createFakeTenant,
  fakeGroupUsers,
  FAKE_SHARED_MAILBOX,
  FAKE_SITE_ADDRESS,
  type FakeTenantOptions,
} from '../../scripts/m365/cassette/fakeTenant';
import { loadCassette, replayReaderFor } from '../../scripts/m365/cassette/replayFetch';
import { sourceRow } from '../../scripts/m365/cassette/record';
import { ALLOWED_RESPONSE_HEADERS } from '../../scripts/m365/cassette/format';
import { REPLAY_ORIGIN } from '../../scripts/m365/cassette/scrub';
import { errorSummary, SYNC_ERROR } from '../../worker/sync';
import { domainRule, exclusionWith, NO_EXCLUSION } from '../google/exclusion';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';

const source: SourceRow = {
  id: '33333333-3333-4333-8333-333333333333',
  tenantId: TENANT,
  kind: SOURCE_KIND.MAILBOX,
  provider: MAILBOX_PROVIDER.MICROSOFT,
  address: 'storm.duncan@bank.example',
  ownerUserId: OWNER,
  deltaCheckpoint: null,
};

const googleSource: SourceRow = { ...source, provider: MAILBOX_PROVIDER.GOOGLE };
/** The provider group holds the address (a Phase 4 mirror that answered). */
const inGroup = () => null;

beforeEach(() => {
  admin.rpc.mockReset();
});

/** A guard that answers the given reasons in order, then allows. */
function guardDb(answers: Array<string | null>) {
  const queue = [...answers];
  const rpc = admin.rpc.mockImplementation(async () => ({ data: queue.length ? queue.shift() : null, error: null }));
  return { rpc };
}

/** Stands in for a Google reader (#259): three pages, counting next() calls. */
function stubSource() {
  const stub = { nexts: 0, opened: 0 };
  const inner: ContentSource = {
    kind: SOURCE_KIND.MAILBOX,
    backfill() {
      stub.opened += 1;
      return {
        [Symbol.asyncIterator]() {
          let page = 0;
          return {
            async next() {
              stub.nexts += 1;
              page += 1;
              if (page > 3) return { done: true as const, value: undefined };
              return { done: false as const, value: { items: [], nextCheckpoint: `stub:${page}` } as SourceItemPage };
            },
          };
        },
      };
    },
    delta() {
      throw new Error('not used');
    },
  };
  return { inner, stub };
}

type Build = (tenantId?: string) => {
  reader: ContentSource;
  stub: { nexts: number; opened: number } | null;
  pages: number;
  row: SourceRow;
};

const builds: Array<[string, Build]> = [
  [
    'microsoft',
    (tenantId = TENANT) => ({
      reader: guardedContentSource({ kind: SOURCE_KIND.MAILBOX, provider: MAILBOX_PROVIDER.MICROSOFT }, READER_MODE.FIXTURE, {
        tenantId,
        providerCheck: inGroup,
      }),
      stub: null,
      pages: 2,
      row: source,
    }),
  ],
  [
    'google',
    (tenantId = TENANT) => {
      const { inner, stub } = stubSource();
      return {
        reader: createGuardedContentSource(inner, { tenantId, providerCheck: inGroup, exclusion: NO_EXCLUSION }, MAILBOX_PROVIDER.GOOGLE),
        stub,
        pages: 3,
        row: googleSource,
      };
    },
  ],
];

async function drain(reader: ContentSource, row: SourceRow = source): Promise<SourceItemPage[]> {
  const pages: SourceItemPage[] = [];
  for await (const page of reader.backfill(row, null)) pages.push(page);
  return pages;
}

describe('the guarded reader marks progress (reader liveness)', () => {
  it('calls onProgress once per page it yields, after the guard allowed the read', async () => {
    guardDb([]);
    const { inner } = stubSource();
    const onProgress = vi.fn();
    const reader = createGuardedContentSource(
      inner,
      { tenantId: TENANT, providerCheck: inGroup, exclusion: NO_EXCLUSION, onProgress },
      MAILBOX_PROVIDER.GOOGLE,
    );
    expect(await drain(reader, googleSource)).toHaveLength(3);
    expect(onProgress).toHaveBeenCalledTimes(3);
  });

  it('marks nothing when the guard refuses before the first page', async () => {
    guardDb(['no_consent']);
    const { inner } = stubSource();
    const onProgress = vi.fn();
    const reader = createGuardedContentSource(
      inner,
      { tenantId: TENANT, providerCheck: inGroup, exclusion: NO_EXCLUSION, onProgress },
      MAILBOX_PROVIDER.GOOGLE,
    );
    await expect(drain(reader, googleSource)).rejects.toBeInstanceOf(MailboxAccessRefusedError);
    expect(onProgress).not.toHaveBeenCalled();
  });
});

describe('the guarded reader claims a first read once the guard admits it (#353)', () => {
  /** An inner reader that records the source each read opened with, in order with the guard and the claim. */
  function recordingSource(log: string[]) {
    const opened: SourceRow[] = [];
    const inner: ContentSource = {
      kind: SOURCE_KIND.MAILBOX,
      async *backfill(row) {
        log.push('open');
        opened.push(row);
        yield { items: [], nextCheckpoint: 'stub:1' };
      },
      async *delta(row) {
        log.push('open');
        opened.push(row);
        yield { items: [], nextCheckpoint: 'stub:1' };
      },
    };
    return { inner, opened };
  }
  const windowed: SourceRow = { ...googleSource, backfillSince: '2026-01-01' };

  it('claims after the guard and before the inner reader, which reads the claimed window, not the loaded one', async () => {
    const log: string[] = [];
    admin.rpc.mockImplementation(async () => {
      log.push('guard');
      return { data: null, error: null };
    });
    const { inner, opened } = recordingSource(log);
    const claimFirstRead = vi.fn(async () => {
      log.push('claim');
      return '2026-07-17';
    });
    const reader = createGuardedContentSource(
      inner,
      { tenantId: TENANT, providerCheck: inGroup, exclusion: NO_EXCLUSION, claimFirstRead },
      MAILBOX_PROVIDER.GOOGLE,
    );
    expect(await drain(reader, windowed)).toHaveLength(1);
    expect(log.slice(0, 3)).toEqual(['guard', 'claim', 'open']);
    expect(claimFirstRead).toHaveBeenCalledTimes(1);
    expect(claimFirstRead).toHaveBeenCalledWith(windowed);
    expect(opened.map((row) => row.backfillSince)).toEqual(['2026-07-17']);
  });

  it('never claims a resumed backfill or a delta pass: their window is the checkpoint\'s', async () => {
    guardDb([]);
    const { inner, opened } = recordingSource([]);
    const claimFirstRead = vi.fn(async () => '2026-07-17');
    const reader = createGuardedContentSource(
      inner,
      { tenantId: TENANT, providerCheck: inGroup, exclusion: NO_EXCLUSION, claimFirstRead },
      MAILBOX_PROVIDER.GOOGLE,
    );
    for await (const page of reader.backfill(windowed, 'stub:0')) void page;
    for await (const page of reader.delta(windowed, 'stub:0')) void page;
    expect(claimFirstRead).not.toHaveBeenCalled();
    expect(opened.map((row) => row.backfillSince)).toEqual(['2026-01-01', '2026-01-01']);
  });

  it('never claims a source the guard refuses, so its window stays open, and never opens the reader', async () => {
    guardDb(['no_consent']);
    const { inner, opened } = recordingSource([]);
    const claimFirstRead = vi.fn(async () => '2026-07-17');
    const reader = createGuardedContentSource(
      inner,
      { tenantId: TENANT, providerCheck: inGroup, exclusion: NO_EXCLUSION, claimFirstRead },
      MAILBOX_PROVIDER.GOOGLE,
    );
    await expect(drain(reader, windowed)).rejects.toBeInstanceOf(MailboxAccessRefusedError);
    expect(claimFirstRead).not.toHaveBeenCalled();
    expect(opened).toEqual([]);
  });

  it('stops before the reader when the claim fails (an archived source matches no row)', async () => {
    guardDb([]);
    const { inner, opened } = recordingSource([]);
    const claimFirstRead = vi.fn(async (): Promise<string | null> => {
      throw new Error('archived');
    });
    const reader = createGuardedContentSource(
      inner,
      { tenantId: TENANT, providerCheck: inGroup, exclusion: NO_EXCLUSION, claimFirstRead },
      MAILBOX_PROVIDER.GOOGLE,
    );
    await expect(drain(reader, windowed)).rejects.toThrow('archived');
    expect(opened).toEqual([]);
  });
});

describe.each(builds)('the guarded reader (%s)', (_provider, build) => {
  it('yields every page when allowed, asking the guard before the first and after each page', async () => {
    const { rpc } = guardDb([]);
    const { reader, pages, row } = build();
    const read = await drain(reader, row);
    expect(read).toHaveLength(pages);
    expect(rpc).toHaveBeenCalledTimes(pages + 1);
  });

  it('refuses at the first check without starting the inner reader', async () => {
    const { rpc } = guardDb(['no_consent']);
    const { reader, stub, row } = build();
    await expect(drain(reader, row)).rejects.toBeInstanceOf(MailboxAccessRefusedError);
    expect(rpc).toHaveBeenCalledTimes(1);
    if (stub) {
      expect(stub.opened).toBe(0);
      expect(stub.nexts).toBe(0);
    }
  });

  it('stops after a refusal following page one, never requesting page two', async () => {
    guardDb([null, 'seat_inactive']);
    const { reader, stub, row } = build();
    const pages: SourceItemPage[] = [];
    const run = async () => {
      for await (const page of reader.backfill(row, null)) pages.push(page);
    };
    await expect(run()).rejects.toMatchObject({ reason: 'seat_inactive' });
    expect(pages).toHaveLength(1);
    if (stub) expect(stub.nexts).toBe(1);
  });

  it('binds the source owner and the reader provider to the guard call', async () => {
    const { rpc } = guardDb([]);
    const { reader, row } = build();
    await drain(reader, row);
    expect(rpc).toHaveBeenNthCalledWith(
      1,
      'mailbox_guard_check',
      expect.objectContaining({
        p_provider: row.provider,
        p_tenant_id: TENANT,
        p_address: source.address,
        p_purpose: 'provider_read',
        p_check_owner: true,
        p_owner_user_id: OWNER,
      }),
    );
  });

  it('throws before any guard call for a source from another tenant', async () => {
    const { rpc } = guardDb([]);
    const { reader, row } = build('99999999-9999-4999-8999-999999999999');
    await expect(drain(reader, row)).rejects.toThrow(/another tenant/);
    expect(rpc).not.toHaveBeenCalled();
  });
});

const siteSource: SourceRow = {
  id: '44444444-4444-4444-8444-444444444444',
  tenantId: TENANT,
  kind: SOURCE_KIND.SHAREPOINT_SITE,
  provider: MAILBOX_PROVIDER.MICROSOFT,
  address: 'bank.sharepoint.com:/sites/deals',
  // #243's configuration may set an owner; a site read never uses it.
  ownerUserId: OWNER,
  deltaCheckpoint: null,
};

/** Stands in for #243's drive reader: three pages of a sharepoint_site source. */
function siteStub() {
  const stub = { nexts: 0, opened: 0 };
  const inner: ContentSource = {
    kind: SOURCE_KIND.SHAREPOINT_SITE,
    backfill() {
      stub.opened += 1;
      return {
        [Symbol.asyncIterator]() {
          let page = 0;
          return {
            async next() {
              stub.nexts += 1;
              page += 1;
              if (page > 3) return { done: true as const, value: undefined };
              return { done: false as const, value: { items: [], nextCheckpoint: `site:${page}` } as SourceItemPage };
            },
          };
        },
      };
    },
    delta() {
      throw new Error('not used');
    },
  };
  return { inner, stub };
}

describe('the guarded reader for a sharepoint_site source (R23)', () => {
  it('asks site_guard_check before each page, never mailbox_guard_check, with no owner or provider arguments', async () => {
    const { rpc } = guardDb([]);
    const { inner } = siteStub();
    const reader = createGuardedContentSource(inner, {
      tenantId: TENANT,
      // A provider check must not be consulted for a site.
      providerCheck: () => 'not_in_provider_group',
    });
    const pages: SourceItemPage[] = [];
    for await (const page of reader.backfill(siteSource, null)) pages.push(page);
    expect(pages).toHaveLength(3);
    expect(rpc).toHaveBeenCalledTimes(4);
    for (const call of rpc.mock.calls) {
      expect(call[0]).toBe('site_guard_check');
      expect(call[1]).toEqual({
        p_tenant_id: TENANT,
        p_address: siteSource.address,
        p_purpose: 'provider_read',
        p_caller: 'discovery-worker',
      });
    }
    expect(rpc.mock.calls.map((call) => call[0])).not.toContain('mailbox_guard_check');
  });

  it('refuses at the first check without starting the inner reader', async () => {
    const { rpc } = guardDb(['site_not_registered']);
    const { inner, stub } = siteStub();
    const reader = createGuardedContentSource(inner, { tenantId: TENANT });
    const run = async () => {
      for await (const page of reader.backfill(siteSource, null)) void page;
    };
    await expect(run()).rejects.toMatchObject({ name: 'MailboxAccessRefusedError', reason: 'site_not_registered' });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(stub.opened).toBe(0);
  });

  it('stops after a refusal following page one, never requesting page two', async () => {
    guardDb([null, 'registration_inactive']);
    const { inner, stub } = siteStub();
    const reader = createGuardedContentSource(inner, { tenantId: TENANT });
    const pages: SourceItemPage[] = [];
    const run = async () => {
      for await (const page of reader.backfill(siteSource, null)) pages.push(page);
    };
    await expect(run()).rejects.toMatchObject({ reason: 'registration_inactive' });
    expect(pages).toHaveLength(1);
    expect(stub.nexts).toBe(1);
  });

  it('throws before any RPC for a source whose kind differs from its reader', async () => {
    const { rpc } = guardDb([]);
    const { inner, stub } = siteStub();
    const reader = createGuardedContentSource(inner, { tenantId: TENANT });
    const run = async () => {
      for await (const page of reader.backfill(source, null)) void page; // a mailbox source, a site reader
    };
    await expect(run()).rejects.toThrow(/kind does not match/);
    expect(rpc).not.toHaveBeenCalled();
    expect(stub.opened).toBe(0);
  });

  it('throws before any RPC for a source of another tenant', async () => {
    const { rpc } = guardDb([]);
    const { inner } = siteStub();
    const reader = createGuardedContentSource(inner, { tenantId: '99999999-9999-4999-8999-999999999999' });
    const run = async () => {
      for await (const page of reader.backfill(siteSource, null)) void page;
    };
    await expect(run()).rejects.toThrow(/another tenant/);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('refuses to wrap a source of any other kind, before any RPC', () => {
    const { rpc } = guardDb([]);
    const inner = { kind: 'drive', backfill: () => ({} as never), delta: () => ({} as never) } as unknown as ContentSource;
    expect(() => createGuardedContentSource(inner, { tenantId: TENANT })).toThrow(/No access guard exists/);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('provider dispatch (C2)', () => {
  const MAILBOX = SOURCE_KIND.MAILBOX;

  describe('google (#259)', () => {
    const run = async (reader: ContentSource, row: SourceRow = googleSource) => {
      for await (const page of reader.backfill(row, null)) void page;
    };

    it('dispatches to the Gmail reader, and asks the guard as google before its first page', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      try {
        const { rpc } = guardDb(['no_consent']);
        const reader = guardedContentSource({ kind: MAILBOX, provider: MAILBOX_PROVIDER.GOOGLE }, READER_MODE.LIVE, {
          tenantId: TENANT,
          providerCheck: inGroup,
          exclusion: exclusionWith([]),
        });
        expect(reader.kind).toBe(MAILBOX);
        await expect(run(reader)).rejects.toMatchObject({ name: 'MailboxAccessRefusedError', reason: 'no_consent' });
        // Guarded before the first page: one guard call, as google, and not one request to Google.
        expect(rpc).toHaveBeenCalledTimes(1);
        expect(rpc).toHaveBeenCalledWith('mailbox_guard_check', expect.objectContaining({ p_provider: 'google' }));
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('refuses mirror_unavailable, before any page, without a providerCheck', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      try {
        const { rpc } = guardDb([]);
        const reader = guardedContentSource({ kind: MAILBOX, provider: MAILBOX_PROVIDER.GOOGLE }, READER_MODE.LIVE, {
          tenantId: TENANT,
          exclusion: exclusionWith([]),
        });
        await expect(run(reader)).rejects.toMatchObject({ reason: 'mirror_unavailable' });
        expect(rpc).toHaveBeenCalledWith('mailbox_guard_check', expect.objectContaining({ p_provider_reason: 'mirror_unavailable' }));
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('refuses a microsoft source before any guard call or request', async () => {
      const { rpc } = guardDb([]);
      const reader = guardedContentSource({ kind: MAILBOX, provider: MAILBOX_PROVIDER.GOOGLE }, READER_MODE.LIVE, {
        tenantId: TENANT,
        providerCheck: inGroup,
        exclusion: exclusionWith([]),
      });
      await expect(run(reader, source)).rejects.toThrow(/source provider does not match its reader/);
      expect(rpc).not.toHaveBeenCalled();
    });

    it('serves mailboxes only', () => {
      expect(() =>
        guardedContentSource({ kind: SOURCE_KIND.SHAREPOINT_SITE, provider: MAILBOX_PROVIDER.GOOGLE }, READER_MODE.LIVE, {
          tenantId: TENANT,
        }),
      ).toThrow(/serves mailboxes only/);
    });

    it('serves the committed Gmail replay in fixture mode, and refuses it in production', () => {
      expect(
        guardedContentSource({ kind: MAILBOX, provider: MAILBOX_PROVIDER.GOOGLE }, READER_MODE.FIXTURE, { tenantId: TENANT }).kind,
      ).toBe(MAILBOX);
      vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'prod');
      try {
        expect(() =>
          guardedContentSource({ kind: MAILBOX, provider: MAILBOX_PROVIDER.GOOGLE }, READER_MODE.FIXTURE, { tenantId: TENANT }),
        ).toThrow(/Gmail replay is refused in production/);
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('reads a microsoft source through the graph reader in live mode as it did as graph', () => {
      // `live` is the mode for every provider; the Graph reader still names it `graph` (#243), so `live`
      // builds the same live Graph reader and needs the same tenant registration, before any guard call.
      const { rpc } = guardDb([]);
      expect(() =>
        guardedContentSource({ kind: MAILBOX, provider: MAILBOX_PROVIDER.MICROSOFT }, READER_MODE.LIVE, { tenantId: TENANT }),
      ).toThrow("a live Microsoft reader needs the tenant's reader registration");
      expect(rpc).not.toHaveBeenCalled();
    });
  });

  it('has no reader for a provider outside the enum, and says so before any guard call', () => {
    const { rpc } = guardDb([]);
    expect(() =>
      guardedContentSource({ kind: MAILBOX, provider: 'yahoo' as never }, READER_MODE.LIVE, { tenantId: TENANT }),
    ).toThrow('No reader registered for provider yahoo');
    expect(rpc).not.toHaveBeenCalled();
  });

  // C8 / C28: a kind or mode no reader serves is a typed, recoverable answer, so the worker can skip
  // that one source and read the rest, instead of aborting the pass on a bare Error.
  it('answers a fixture site with UnsupportedSourceError, before any guard call', () => {
    const { rpc } = guardDb([]);
    const build = () =>
      guardedContentSource({ kind: SOURCE_KIND.SHAREPOINT_SITE, provider: MAILBOX_PROVIDER.MICROSOFT }, READER_MODE.FIXTURE, {
        tenantId: TENANT,
      });
    expect(build).toThrow(UnsupportedSourceError);
    expect(build).toThrow('The fixture reader serves mailboxes only, not sharepoint_site');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('answers a provider with no reader with UnsupportedSourceError too, keeping its message', () => {
    expect(() =>
      guardedContentSource({ kind: MAILBOX, provider: 'yahoo' as never }, READER_MODE.FIXTURE, { tenantId: TENANT }),
    ).toThrow(new UnsupportedSourceError(MAILBOX, 'yahoo', READER_MODE.FIXTURE, 'No reader registered for provider yahoo'));
  });

  it('answers a Google source that is not a mailbox with UnsupportedSourceError: the Gmail reader serves mailboxes only (#259)', () => {
    for (const mode of [READER_MODE.FIXTURE, READER_MODE.LIVE]) {
      expect(() =>
        guardedContentSource({ kind: SOURCE_KIND.SHAREPOINT_SITE, provider: MAILBOX_PROVIDER.GOOGLE }, mode, { tenantId: TENANT }),
      ).toThrow(UnsupportedSourceError);
    }
  });

  it('never treats a missing live registration as unsupported: that is a wiring fault', () => {
    let thrown: unknown;
    try {
      guardedContentSource({ kind: MAILBOX, provider: MAILBOX_PROVIDER.MICROSOFT }, READER_MODE.GRAPH, { tenantId: TENANT });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(UnsupportedSourceError);
  });

  it('builds no live Microsoft reader without the tenant registration, before any guard call (#243)', () => {
    const { rpc } = guardDb([]);
    expect(() =>
      guardedContentSource({ kind: MAILBOX, provider: MAILBOX_PROVIDER.MICROSOFT }, READER_MODE.GRAPH, {
        tenantId: TENANT,
        providerCheck: inGroup,
      }),
    ).toThrow("a live Microsoft reader needs the tenant's reader registration");
    expect(rpc).not.toHaveBeenCalled();
  });

  it('has no reader for a provider outside the enum either', () => {
    expect(() =>
      guardedContentSource({ kind: MAILBOX, provider: 'yahoo' as never }, READER_MODE.FIXTURE, { tenantId: TENANT }),
    ).toThrow('No reader registered for provider yahoo');
  });

  it('serves a microsoft source, and refuses a google source before any guard call or page', async () => {
    const { rpc } = guardDb([]);
    const reader = guardedContentSource({ kind: MAILBOX, provider: MAILBOX_PROVIDER.MICROSOFT }, READER_MODE.FIXTURE, {
      tenantId: TENANT,
      providerCheck: inGroup,
    });
    const run = async () => {
      for await (const page of reader.backfill({ ...source, provider: MAILBOX_PROVIDER.GOOGLE }, null)) void page;
    };
    await expect(run()).rejects.toThrow(/source provider does not match its reader/);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('holds a google reader (the #259 stub) to google sources only', async () => {
    const { rpc } = guardDb([]);
    const { inner, stub } = stubSource();
    const reader = createGuardedContentSource(inner, { tenantId: TENANT, providerCheck: inGroup, exclusion: NO_EXCLUSION }, MAILBOX_PROVIDER.GOOGLE);
    const run = async (row: SourceRow) => {
      for await (const page of reader.backfill(row, null)) void page;
    };
    await expect(run(source)).rejects.toThrow(/source provider does not match its reader/);
    expect(rpc).not.toHaveBeenCalled();
    expect(stub.opened).toBe(0);
    await run({ ...source, provider: MAILBOX_PROVIDER.GOOGLE });
    expect(stub.nexts).toBe(4);
  });
});

describe('a mailbox read needs the provider group check (round 2, item 4)', () => {
  const MAILBOX = SOURCE_KIND.MAILBOX;
  const run = async (reader: ContentSource, row: SourceRow = source) => {
    for await (const page of reader.backfill(row, null)) void page;
  };

  it('refuses mirror_unavailable before any page when a mailbox read carries no providerCheck', async () => {
    // The guard is mocked to allow everything: the refusal must not depend on its answer.
    const { rpc } = guardDb([]);
    const reader = guardedContentSource({ kind: MAILBOX, provider: MAILBOX_PROVIDER.MICROSOFT }, READER_MODE.FIXTURE, {
      tenantId: TENANT,
    });
    const pages: SourceItemPage[] = [];
    const attempt = async () => {
      for await (const page of reader.backfill(source, null)) pages.push(page);
    };
    await expect(attempt()).rejects.toMatchObject({ name: 'MailboxAccessRefusedError', reason: 'mirror_unavailable' });
    expect(pages).toEqual([]);
    // The guard was asked once (so the refusal is audited), with the reason it must refuse on.
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('mailbox_guard_check', expect.objectContaining({ p_provider_reason: 'mirror_unavailable' }));
  });

  it('refuses a google stub reader with no providerCheck, and never opens it', async () => {
    guardDb([]);
    const { inner, stub } = stubSource();
    const reader = createGuardedContentSource(inner, { tenantId: TENANT, exclusion: NO_EXCLUSION }, MAILBOX_PROVIDER.GOOGLE);
    await expect(run(reader, googleSource)).rejects.toMatchObject({ reason: 'mirror_unavailable' });
    expect(stub.opened).toBe(0);
    expect(stub.nexts).toBe(0);
  });

  it('a check that says the address is outside the group still refuses with its own reason', async () => {
    const reader = guardedContentSource({ kind: MAILBOX, provider: MAILBOX_PROVIDER.MICROSOFT }, READER_MODE.FIXTURE, {
      tenantId: TENANT,
      providerCheck: () => 'not_in_provider_group',
    });
    const { rpc } = guardDb([]);
    // The guard mock allows everything, so the refusal below can only come from the check's own answer.
    await expect(run(reader)).rejects.toMatchObject({ name: 'MailboxAccessRefusedError', reason: 'not_in_provider_group' });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('mailbox_guard_check', expect.objectContaining({ p_provider_reason: 'not_in_provider_group' }));
  });

  // Round 3, item 5: the check must be a function, and only null (in the group) or a
  // known provider reason is an answer. Anything else is a fault and fails closed.
  it.each<[string, unknown]>([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'in-group'],
    ['an object', {}],
    ['true', true],
  ])('refuses mirror_unavailable, audited, when providerCheck is %s', async (_label, providerCheck) => {
    const { rpc } = guardDb([]);
    const { inner, stub } = stubSource();
    const reader = createGuardedContentSource(
      inner,
      { tenantId: TENANT, providerCheck: providerCheck as never, exclusion: NO_EXCLUSION },
      MAILBOX_PROVIDER.GOOGLE,
    );
    await expect(run(reader, googleSource)).rejects.toMatchObject({
      name: 'MailboxAccessRefusedError',
      reason: 'mirror_unavailable',
    });
    expect(stub.opened).toBe(0);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('mailbox_guard_check', expect.objectContaining({ p_provider_reason: 'mirror_unavailable' }));
  });

  it.each<[string, () => unknown]>([
    ['undefined', () => undefined],
    ['false', () => false],
    ['true', () => true],
    ['an empty string', () => ''],
    ['an unknown string', () => 'no_consent'],
    ['an object', () => ({ reason: 'not_in_provider_group' })],
    ['a promise', () => Promise.resolve(null)],
    ['a rejected promise', () => Promise.reject(new Error('mirror down'))],
    [
      'a thrown error',
      () => {
        throw new Error('mirror down');
      },
    ],
  ])('refuses mirror_unavailable, audited, when the check returns %s', async (_label, check) => {
    const { rpc } = guardDb([]);
    const { inner, stub } = stubSource();
    const reader = createGuardedContentSource(
      inner,
      { tenantId: TENANT, providerCheck: check as never, exclusion: NO_EXCLUSION },
      MAILBOX_PROVIDER.GOOGLE,
    );
    await expect(run(reader, googleSource)).rejects.toMatchObject({
      name: 'MailboxAccessRefusedError',
      reason: 'mirror_unavailable',
    });
    expect(stub.opened).toBe(0);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('mailbox_guard_check', expect.objectContaining({ p_provider_reason: 'mirror_unavailable' }));
  });

  it('refuses when the guard answers allowed but the check named a reason (an inconsistent guard fails closed)', async () => {
    guardDb([]);
    const { inner, stub } = stubSource();
    const reader = createGuardedContentSource(
      inner,
      { tenantId: TENANT, providerCheck: () => 'not_in_provider_group', exclusion: NO_EXCLUSION },
      MAILBOX_PROVIDER.GOOGLE,
    );
    await expect(run(reader, googleSource)).rejects.toMatchObject({ reason: 'not_in_provider_group' });
    expect(stub.opened).toBe(0);
  });

  it('a sharepoint_site read still needs no providerCheck', async () => {
    const { rpc } = guardDb([]);
    const { inner } = siteStub();
    const reader = createGuardedContentSource(inner, { tenantId: TENANT });
    await run(reader, siteSource);
    // One check before each of the three pages and one before the end: a guard that was never asked would
    // pass a bare `every`, so the count is pinned, and so is the absence of a mailbox check.
    expect(rpc).toHaveBeenCalledTimes(4);
    expect(rpc.mock.calls.map((call) => call[0])).toEqual(Array(4).fill('site_guard_check'));
  });
});

describe('a mailbox reader names its provider to the guard (round 2, item 6)', () => {
  it('refuses to build a mailbox reader without a provider, before any guard call', () => {
    const { rpc } = guardDb([]);
    const { inner } = stubSource();
    expect(() => createGuardedContentSource(inner, { tenantId: TENANT, providerCheck: inGroup })).toThrow(
      /needs the provider it reads through/,
    );
    expect(rpc).not.toHaveBeenCalled();
  });

  it('surfaces the guard provider_mismatch refusal and stops the read', async () => {
    guardDb(['provider_mismatch']);
    const { inner, stub } = stubSource();
    const reader = createGuardedContentSource(inner, { tenantId: TENANT, providerCheck: inGroup, exclusion: NO_EXCLUSION }, MAILBOX_PROVIDER.GOOGLE);
    const attempt = async () => {
      for await (const page of reader.backfill(googleSource, null)) void page;
    };
    await expect(attempt()).rejects.toMatchObject({ name: 'MailboxAccessRefusedError', reason: 'provider_mismatch' });
    expect(stub.opened).toBe(0);
  });
});

// #263: the exclusion policy is asked by the wrapper, before the guard, any token mint or any request.
describe('the exclusion policy at the guard wrapper (#263)', () => {
  const run = async (reader: ContentSource, row: SourceRow) => {
    for await (const page of reader.backfill(row, null)) void page;
  };

  it('refuses a Gmail reader whose context has no exclusion policy, on the first read, before the guard and without opening it', async () => {
    const { rpc } = guardDb([]);
    const { inner, stub } = stubSource();
    const reader = createGuardedContentSource(inner, { tenantId: TENANT, providerCheck: inGroup }, MAILBOX_PROVIDER.GOOGLE);
    await expect(run(reader, googleSource)).rejects.toThrow(/needs the tenant exclusion policy/);
    expect(rpc).not.toHaveBeenCalled();
    expect(stub.opened).toBe(0);
  });

  it.each([
    ['missing', 'NoExclusionPolicyError'],
    ['invalid', 'InvalidExclusionPolicyError'],
  ] as const)('refuses an unavailable (%s) policy on the first read for either provider, before the guard, opening nothing', async (unavailable, name) => {
    for (const provider of [MAILBOX_PROVIDER.GOOGLE, MAILBOX_PROVIDER.MICROSOFT]) {
      const { rpc } = guardDb([]);
      const { inner, stub } = stubSource();
      const reader = createGuardedContentSource(
        inner,
        { tenantId: TENANT, providerCheck: inGroup, exclusion: { policy: { unavailable }, threadTaint: new Map() } },
        provider,
      );
      await expect(run(reader, { ...source, provider })).rejects.toMatchObject({ name });
      // The error carries no rule content.
      expect(rpc).not.toHaveBeenCalled();
      expect(stub.opened).toBe(0);
    }
  });

  it('refuses a Microsoft source under a non-empty policy, and reads it under version 0 or an empty policy', async () => {
    const { rpc } = guardDb([]);
    const { inner, stub } = stubSource();
    const refused = createGuardedContentSource(
      inner,
      { tenantId: TENANT, providerCheck: inGroup, exclusion: exclusionWith([domainRule('counsel', 'counsel.example')]) },
      MAILBOX_PROVIDER.MICROSOFT,
    );
    await expect(run(refused, source)).rejects.toThrow('Exclusion policy is not enforced on Microsoft yet (#272)');
    expect(rpc).not.toHaveBeenCalled();
    expect(stub.opened).toBe(0);

    for (const exclusion of [NO_EXCLUSION, exclusionWith([], 5), undefined]) {
      const again = stubSource();
      const reader = createGuardedContentSource(again.inner, { tenantId: TENANT, providerCheck: inGroup, exclusion }, MAILBOX_PROVIDER.MICROSOFT);
      await run(reader, source);
      expect(again.stub.nexts).toBe(4);
    }
  });

  it('reads a Microsoft site under a non-empty policy and refuses a Microsoft mailbox: the policy is mail metadata (audit C2)', async () => {
    const counsel = exclusionWith([domainRule('counsel', 'counsel.example')]);
    guardDb([]);
    const site = siteStub();
    const siteReader = createGuardedContentSource(site.inner, { tenantId: TENANT, exclusion: counsel }, MAILBOX_PROVIDER.MICROSOFT);
    await run(siteReader, siteSource);
    expect(site.stub.opened).toBe(1);

    const mailbox = stubSource();
    const mailboxReader = createGuardedContentSource(
      mailbox.inner,
      { tenantId: TENANT, providerCheck: inGroup, exclusion: counsel },
      MAILBOX_PROVIDER.MICROSOFT,
    );
    await expect(run(mailboxReader, source)).rejects.toThrow(/not enforced on Microsoft/);
    expect(mailbox.stub.opened).toBe(0);
  });

  it('refuses a Gmail source in graph mode under version 0 when the reader is built, before any guard call or request (audit C1)', () => {
    const { rpc } = guardDb([]);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      expect(() =>
        guardedContentSource({ kind: SOURCE_KIND.MAILBOX, provider: MAILBOX_PROVIDER.GOOGLE }, READER_MODE.GRAPH, {
          tenantId: TENANT,
          providerCheck: inGroup,
          exclusion: NO_EXCLUSION,
        }),
      ).toThrow(expect.objectContaining({ name: 'NoExclusionPolicyError' }));
      expect(rpc).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('refuses a pass over the recorded Graph cassette under a non-empty policy without one request to it', async () => {
    const { rpc } = guardDb([]);
    const cassette = loadCassette(SYNTHETIC_CASSETTE_DIR);
    const cassetteSource = cassette.manifest.sources.find((s) => s.kind === SOURCE_KIND.MAILBOX);
    expect(cassetteSource).toBeDefined();
    const row = sourceRow(cassetteSource!, 0);
    const inner = replayReaderFor(cassette)({ ...row, backfillCompletedAt: null });
    const reader = createGuardedContentSource(
      inner,
      { tenantId: row.tenantId, providerCheck: inGroup, exclusion: exclusionWith([domainRule('counsel', 'counsel.example')]) },
      MAILBOX_PROVIDER.MICROSOFT,
    );
    await expect(run(reader, row)).rejects.toThrow(/not enforced on Microsoft/);
    expect(cassette.fetch.requests).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
  });
});

// The pass record (#370): the wrapper forwards the registration its inner reader reports, raw (the worker
// normalizes it), and reports none when the inner has none. A registration is public ids, never a credential.
describe('the guarded reader reports its registration (#370)', () => {
  const MAILBOX = SOURCE_KIND.MAILBOX;
  const THUMB = 'AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01';
  const registration = {
    tenantId: TENANT,
    msTenantId: '44444444-4444-4444-8444-444444444444',
    clientId: '55555555-5555-4555-8555-555555555555',
    certThumbprint: THUMB,
    certSecretRef: 'keyvault:https://bankvault.vault.azure.net/keys/reader/abc123',
  };

  it('forwards the inner reader registration, and null when the inner has none', () => {
    const inner: ContentSource = {
      kind: SOURCE_KIND.MAILBOX,
      backfill: async function* () {},
      delta: async function* () {},
    };
    const ctx = { tenantId: TENANT, providerCheck: inGroup, exclusion: NO_EXCLUSION };
    expect(createGuardedContentSource(inner, ctx, MAILBOX_PROVIDER.GOOGLE).registration?.()).toBeNull();
    const withRef = { ...inner, registration: () => ({ clientId: '123', certThumbprint: null }) };
    expect(createGuardedContentSource(withRef, ctx, MAILBOX_PROVIDER.GOOGLE).registration?.()).toEqual({
      clientId: '123',
      certThumbprint: null,
    });
  });

  it('reports the live Microsoft registration raw, as stored, before any guard call or token', () => {
    const { rpc } = guardDb([]);
    for (const mode of [READER_MODE.GRAPH, READER_MODE.LIVE]) {
      const reader = guardedContentSource({ kind: MAILBOX, provider: MAILBOX_PROVIDER.MICROSOFT }, mode, {
        tenantId: TENANT,
        providerCheck: inGroup,
        graphRegistration: registration,
      });
      expect(reader.registration?.()).toEqual({ clientId: registration.clientId, certThumbprint: THUMB });
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it('reports none for the fixture reader and the Gmail replay', () => {
    const graphFixture = guardedContentSource({ kind: MAILBOX, provider: MAILBOX_PROVIDER.MICROSOFT }, READER_MODE.FIXTURE, {
      tenantId: TENANT,
      providerCheck: inGroup,
    });
    expect(graphFixture.registration?.()).toBeNull();
    const gmailReplay = guardedContentSource({ kind: MAILBOX, provider: MAILBOX_PROVIDER.GOOGLE }, READER_MODE.FIXTURE, {
      tenantId: TENANT,
      providerCheck: inGroup,
      exclusion: NO_EXCLUSION,
    });
    expect(gmailReplay.registration?.()).toBeNull();
  });
});

// A team inbox (#581, design R7): the guard refuses a team source whose last Directory confirmation is 65 minutes old,
// and a long backfill or a --recount re-read can outlive that. Between two pages the wrapper may renew the check once and
// ask the guard again; the guard's second answer is the only thing that lets the next page be requested.
describe('a team source whose confirmation ages out mid-pass (#581)', () => {
  const TEAM_ID = '55555555-5555-4555-8555-555555555555';
  const teamSource: SourceRow = {
    ...googleSource,
    address: 'deals@bank.example',
    ownerUserId: null,
    teamMailboxId: TEAM_ID,
  };
  const STALE = 'team_mailbox_unverified';

  function teamReader(options: { recheckTeam?: () => Promise<void> } = {}) {
    const { inner, stub } = stubSource();
    const reader = createGuardedContentSource(
      inner,
      { tenantId: TENANT, providerCheck: inGroup, exclusion: NO_EXCLUSION, ...options },
      MAILBOX_PROVIDER.GOOGLE,
    );
    return { reader, stub };
  }

  /** Reads until the reader ends or throws; the pages that arrived first, and the error if any. */
  async function readAll(reader: ContentSource, row: SourceRow) {
    const pages: SourceItemPage[] = [];
    try {
      for await (const page of reader.backfill(row, null)) pages.push(page);
    } catch (error) {
      return { pages, error };
    }
    return { pages, error: null as unknown };
  }

  it('renews the check once, asks the guard again, and finishes the same pass when the guard then allows it', async () => {
    // One shared timeline of the guard's answers and the renewal, to show the order they happen in.
    const events: string[] = [];
    const answers = [null, STALE, null, null, null];
    admin.rpc.mockImplementation(async () => {
      events.push('guard');
      return { data: answers.shift() ?? null, error: null };
    });
    const recheckTeam = vi.fn(async () => {
      events.push('recheck');
    });
    const { reader, stub } = teamReader({ recheckTeam });

    const { pages, error } = await readAll(reader, teamSource);

    expect(error).toBeNull();
    expect(pages).toHaveLength(3);
    expect(stub.nexts).toBe(4);
    expect(recheckTeam).toHaveBeenCalledTimes(1);
    // The guard refused after the first page, the check was renewed, and the guard was asked again before page two.
    expect(events).toEqual(['guard', 'guard', 'recheck', 'guard', 'guard', 'guard']);
  });

  it('stops the pass at the second refusal: the renewal is not an answer', async () => {
    guardDb([null, STALE, STALE]);
    const recheckTeam = vi.fn(async () => undefined);
    const { reader, stub } = teamReader({ recheckTeam });

    const { pages, error } = await readAll(reader, teamSource);

    expect(error).toBeInstanceOf(MailboxAccessRefusedError);
    expect(error).toMatchObject({ reason: STALE, purpose: 'provider_read' });
    expect(pages).toHaveLength(1);
    expect(stub.nexts).toBe(1);
    expect(recheckTeam).toHaveBeenCalledTimes(1);
  });

  it('renews at most once per reader: a read that goes stale again stops there', async () => {
    const { rpc } = guardDb([null, STALE, null, STALE]);
    const recheckTeam = vi.fn(async () => undefined);
    const { reader } = teamReader({ recheckTeam });

    const { pages, error } = await readAll(reader, teamSource);

    expect(error).toMatchObject({ reason: STALE });
    expect(pages).toHaveLength(2);
    expect(recheckTeam).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledTimes(4);
  });

  it('does not renew before the first page: a stale check there stops the read before the reader is even opened', async () => {
    guardDb([STALE]);
    const recheckTeam = vi.fn(async () => undefined);
    const { reader, stub } = teamReader({ recheckTeam });

    const { pages, error } = await readAll(reader, teamSource);

    expect(error).toMatchObject({ reason: STALE });
    expect(pages).toHaveLength(0);
    expect(stub.opened).toBe(0);
    expect(recheckTeam).not.toHaveBeenCalled();
  });

  it('stops at the first stale answer when the worker gave no way to renew', async () => {
    guardDb([null, STALE, null, null, null]);
    const { reader } = teamReader();

    const { pages, error } = await readAll(reader, teamSource);

    expect(error).toMatchObject({ reason: STALE });
    expect(pages).toHaveLength(1);
  });

  it.each(['source_paused', 'owner_mismatch', 'registration_inactive', 'team_mailbox_disconnected', 'team_mailbox_person', 'no_source'])(
    'does not renew for %s: only a stale confirmation is renewed',
    async (reason) => {
      guardDb([null, reason]);
      const recheckTeam = vi.fn(async () => undefined);
      const { reader } = teamReader({ recheckTeam });

      const { pages, error } = await readAll(reader, teamSource);

      expect(error).toMatchObject({ reason });
      expect(pages).toHaveLength(1);
      expect(recheckTeam).not.toHaveBeenCalled();
    },
  );

  it('does not renew a source that belongs to no registration, whatever the worker passed', async () => {
    guardDb([null, STALE]);
    const recheckTeam = vi.fn(async () => undefined);
    const { reader } = teamReader({ recheckTeam });

    const { error } = await readAll(reader, { ...googleSource, ownerUserId: OWNER });

    expect(error).toMatchObject({ reason: STALE });
    expect(recheckTeam).not.toHaveBeenCalled();
  });

  it('stops when the renewal itself fails, and asks the guard nothing more', async () => {
    const { rpc } = guardDb([null, STALE, null, null]);
    const { reader, stub } = teamReader({
      recheckTeam: async () => {
        throw new Error('team mailbox check could not be recorded (57014)');
      },
    });

    const { pages, error } = await readAll(reader, teamSource);

    expect((error as Error).message).toBe('team mailbox check could not be recorded (57014)');
    expect(pages).toHaveLength(1);
    expect(stub.nexts).toBe(1);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('stops when the guard cannot be asked again after the renewal (fails closed)', async () => {
    let calls = 0;
    admin.rpc.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return { data: null, error: null };
      if (calls === 2) return { data: STALE, error: null };
      return { data: null, error: { code: '57014', message: 'canceling statement' } };
    });
    const { reader } = teamReader({ recheckTeam: async () => undefined });

    const { pages, error } = await readAll(reader, teamSource);

    expect(error).not.toBeInstanceOf(MailboxAccessRefusedError);
    expect((error as Error).message).toBe('mailbox guard unavailable (57014)');
    expect(pages).toHaveLength(1);
  });

  it('asks the guard about the team source as the worker does: provider_read, no owner, the Gmail provider', async () => {
    const { rpc } = guardDb([]);
    const { reader } = teamReader({ recheckTeam: async () => undefined });

    await readAll(reader, teamSource);

    expect(rpc).toHaveBeenCalledWith(
      'mailbox_guard_check',
      expect.objectContaining({
        p_purpose: 'provider_read',
        p_check_owner: true,
        p_owner_user_id: null,
        p_provider: 'google',
        p_address: 'deals@bank.example',
      }),
    );
  });
});

// In fixture mode the replay folder is the mailbox: a team source is read by the real Gmail reader over a replay, behind
// the same guard, and the guard sees what the worker's read is: provider_read, the Gmail provider, no owner.
describe('a team source in fixture mode reads the replay through the guard (#581)', () => {
  const TEAM_ID = '55555555-5555-4555-8555-555555555555';
  const STORM = 'storm.duncan@bank.example';
  const teamRow: SourceRow = { ...googleSource, address: STORM, ownerUserId: null, teamMailboxId: TEAM_ID };

  afterEach(() => vi.unstubAllEnvs());

  function fixtureReader() {
    vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'local');
    vi.stubEnv('DISCOVERY_GMAIL_REPLAY_DIR', join(process.cwd(), 'tests', 'fixtures', 'discovery', 'gmail-twin'));
    return guardedContentSource({ kind: SOURCE_KIND.MAILBOX, provider: MAILBOX_PROVIDER.GOOGLE }, READER_MODE.FIXTURE, {
      tenantId: TENANT,
      providerCheck: inGroup,
      exclusion: NO_EXCLUSION,
    });
  }

  it('reads the mailbox whose profile is the team address, asking the guard before every page', async () => {
    const { rpc } = guardDb([]);
    const pages = await drain(fixtureReader(), teamRow);
    expect(pages.flatMap((page) => page.items).length).toBeGreaterThan(0);
    // One question before the first page, and one after each page.
    expect(rpc).toHaveBeenCalledTimes(pages.length + 1);
    expect(rpc).toHaveBeenCalledWith(
      'mailbox_guard_check',
      expect.objectContaining({
        p_address: STORM,
        p_purpose: 'provider_read',
        p_check_owner: true,
        p_owner_user_id: null,
        p_provider: 'google',
      }),
    );
  });

  it('reads nothing when the guard refuses the team source (a stale or unconfirmed registration)', async () => {
    guardDb(['team_mailbox_unverified']);
    const error = await drain(fixtureReader(), teamRow).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MailboxAccessRefusedError);
    expect(error).toMatchObject({ reason: 'team_mailbox_unverified' });
  });
});

// #275 design R4 (slice 4): a live Microsoft mailbox read reaches the one directory object its allowlisted address is
// bound to. Once the provider check admits the address, the guard's read-only verdict (mailbox_guard_verdict, no state)
// is asked; only if it allows does the binding check read the bound member's inbox by object id and by UPN, so no
// Graph request precedes a guard decision (#262). Then mailbox_guard_check is asked once before the first page, with
// mirror_unavailable when the binding failed (one state-writing call, so one audit row however often the read is
// attempted, #275 audit item 1), and after every page; the mail is read by the UPN. A site has no group and no binding.
describe('a live Microsoft mailbox read is bound to one directory object (#275 design R4)', () => {
  const GRAPH = 'https://graph.microsoft.com/v1.0';
  const MAILBOX = SOURCE_KIND.MAILBOX;
  // Built as the worker builds it (the certificate source is never asked: the fake's token stands in).
  const registration = {
    tenantId: TENANT,
    msTenantId: '44444444-4444-4444-8444-444444444444',
    clientId: '55555555-5555-4555-8555-555555555555',
    certThumbprint: 'AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01',
    certSecretRef: 'keyvault:https://bankvault.vault.azure.net/keys/reader/abc123',
  };
  const STORM = { upn: source.address, id: fakeGroupUsers().find((user) => user.mail.toLowerCase() === source.address)!.id };
  const SHARED_KEY = { upn: FAKE_SHARED_MAILBOX.upn, id: FAKE_SHARED_MAILBOX.id };
  // The team inbox as the allowlist holds it: its mail, which is not its UPN.
  const sharedSource: SourceRow = { ...source, id: '55555555-5555-4555-8555-555555555555', address: FAKE_SHARED_MAILBOX.mail };
  const inbox = (key: string) => `${GRAPH}/users/${encodeURIComponent(key)}/mailFolders/inbox?$select=id`;

  // Guard RPCs and Graph requests, in the order they happened.
  let events: string[] = [];

  /** A live reader over a fresh fake tenant, and the requests the tenant saw. */
  function live(readKey: unknown, options: FakeTenantOptions = {}, extra: Pick<GuardedReaderContext, 'claimFirstRead'> = {}) {
    const tenant = createFakeTenant(options);
    graphWire.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      events.push('graph');
      return tenant.fetch(input, init);
    }) as typeof fetch;
    const reader = guardedContentSource({ kind: MAILBOX, provider: MAILBOX_PROVIDER.MICROSOFT }, READER_MODE.LIVE, {
      tenantId: TENANT,
      providerCheck: inGroup,
      readKey: readKey as never,
      graphRegistration: registration,
      exclusion: NO_EXCLUSION,
      ...extra,
    });
    return { reader, requests: tenant.requests };
  }

  async function read(pages: AsyncIterable<SourceItemPage>): Promise<SourceItemPage[]> {
    const out: SourceItemPage[] = [];
    for await (const page of pages) out.push(page);
    return out;
  }

  const callsTo = (name: string) =>
    admin.rpc.mock.calls.filter((call) => call[0] === name).map((call) => call[1] as Record<string, unknown>);
  /** The state-writing guard calls (mailbox_guard_check). */
  const guardCalls = () => callsTo('mailbox_guard_check');
  /** The read-only verdicts (mailbox_guard_verdict). */
  const verdictCalls = () => callsTo('mailbox_guard_verdict');

  /**
   * The guard RPCs as the database answers them: mailbox_guard_verdict from its queue, then allowed; mailbox_guard_check
   * from its queue, else as the SQL decides, coalesce(the verdict, p_provider_reason). Any other RPC is allowed.
   */
  function guards(answers: { verdict?: Array<string | null>; check?: Array<string | null> } = {}) {
    const verdicts = [...(answers.verdict ?? [])];
    const checks = [...(answers.check ?? [])];
    let verdict: string | null = null;
    const rpc = admin.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      events.push(`rpc:${name}`);
      if (name === 'mailbox_guard_verdict') {
        verdict = verdicts.length ? verdicts.shift()! : null;
        return { data: verdict, error: null };
      }
      if (name === 'mailbox_guard_check') {
        const data = checks.length ? checks.shift()! : (verdict ?? (args.p_provider_reason as string | null) ?? null);
        return { data, error: null };
      }
      return { data: null, error: null };
    });
    return { rpc };
  }

  afterEach(() => {
    graphWire.fetch = null;
    events = [];
  });

  it('guards the stored address on every page, checks the binding before any mail request, and reads the mailbox by its UPN', async () => {
    guards();
    const { reader, requests } = live(() => STORM);
    const pages = await read(reader.backfill(source, null));
    expect(pages.length).toBeGreaterThan(1);
    // The read-only verdict first, with the arguments mailbox_guard_check passes it; then the binding check's two
    // requests; then the one state-writing guard call before the first page.
    expect(verdictCalls()).toEqual([
      { p_tenant_id: TENANT, p_address: source.address, p_provider: 'microsoft', p_check_owner: true, p_owner_user_id: OWNER },
    ]);
    expect(events.slice(0, 4)).toEqual(['rpc:mailbox_guard_verdict', 'graph', 'graph', 'rpc:mailbox_guard_check']);
    // The guard, before the first page and after each one, on the stored address with no provider reason.
    expect(guardCalls()).toHaveLength(pages.length + 1);
    for (const call of guardCalls()) {
      expect(call).toMatchObject({ p_address: source.address, p_provider_reason: null, p_purpose: 'provider_read' });
    }
    // The binding check's two inbox requests, by object id then by UPN, before anything else.
    expect(requests.slice(0, 2)).toEqual([inbox(STORM.id), inbox(STORM.upn)]);
    // Then the mail, by the UPN: here the address, so the URLs are the reader's usual ones.
    const mail = requests.slice(2);
    expect(mail.length).toBeGreaterThan(0);
    for (const url of mail) expect(url.startsWith(`${GRAPH}/users/storm.duncan%40bank.example/mailFolders`)).toBe(true);
    expect(mail).not.toContain(inbox(STORM.upn));
  });

  it('reads a shared mailbox by its UPN while the guard sees its allowlisted mail, and resumes from its own links', async () => {
    guards();
    const { reader, requests } = live(() => SHARED_KEY);
    const pages = await read(reader.backfill(sharedSource, null));
    for (const call of guardCalls()) expect(call.p_address).toBe(FAKE_SHARED_MAILBOX.mail);
    expect(requests.slice(0, 2)).toEqual([inbox(SHARED_KEY.id), inbox(SHARED_KEY.upn)]);
    for (const url of requests.slice(2)) {
      expect(url.startsWith(`${GRAPH}/users/deals%40bankexample.onmicrosoft.com/`)).toBe(true);
    }
    // The stored address is never a path key.
    expect(requests.some((url) => url.includes('deals%40bank.example'))).toBe(false);

    // The checkpoint's links address the UPN, so a delta from it passes the checkpoint key check.
    const token = pages.at(-1)!.nextCheckpoint!;
    requests.length = 0;
    await expect(read(reader.delta(sharedSource, token))).resolves.toBeDefined();
    expect(requests.slice(0, 2)).toEqual([inbox(SHARED_KEY.id), inbox(SHARED_KEY.upn)]);
    expect(requests.some((url) => url.includes('$deltatoken='))).toBe(true);
  });

  it.each([
    ['answer another folder by object id than by UPN', () => SHARED_KEY, { mismatchInboxById: true }, 2],
    ['not know the object id (404)', () => ({ ...SHARED_KEY, id: '00000000-0000-4000-8000-0000000001ff' }), {}, 1],
  ] as Array<[string, () => unknown, FakeTenantOptions, number]>)(
    'refuses as mirror_unavailable, audited through the guard, when the inbox requests %s, before any mail request',
    async (_label, readKey, options, inboxRequests) => {
      guards();
      const { reader, requests } = live(readKey, options);
      await expect(read(reader.backfill(sharedSource, null))).rejects.toMatchObject({
        name: 'MailboxAccessRefusedError',
        reason: 'mirror_unavailable',
      });
      expect(requests).toHaveLength(inboxRequests);
      expect(requests.every((url) => url.endsWith('/mailFolders/inbox?$select=id'))).toBe(true);
      // One state-writing guard call, after the verdict, which records why the read stops.
      expect(verdictCalls()).toHaveLength(1);
      expect(guardCalls()).toHaveLength(1);
      expect(guardCalls()[0]).toMatchObject({ p_address: FAKE_SHARED_MAILBOX.mail, p_provider_reason: 'mirror_unavailable', p_purpose: 'provider_read' });
    },
  );

  it.each<[string, unknown]>([
    ['missing', undefined],
    ['not a function', SHARED_KEY],
    ['a lookup that throws', () => {
      throw new Error('mirror down');
    }],
    ['no key for the address', () => null],
    ['a key with a malformed object id', () => ({ ...SHARED_KEY, id: 'id-a' })],
    ['a key with a blank UPN', () => ({ ...SHARED_KEY, upn: '  ' })],
    ['a promise', () => Promise.resolve(SHARED_KEY)],
    ['a rejected promise', () => Promise.reject(new Error('mirror down'))],
  ])('refuses as mirror_unavailable, audited, with no Graph request at all, when the read key is %s', async (_label, readKey) => {
    guards();
    const { reader, requests } = live(readKey);
    await expect(read(reader.backfill(sharedSource, null))).rejects.toMatchObject({ reason: 'mirror_unavailable' });
    expect(requests).toEqual([]);
    expect(guardCalls()).toHaveLength(1);
    expect(guardCalls()[0]).toMatchObject({ p_provider_reason: 'mirror_unavailable' });
  });

  it('makes no binding request and asks no verdict for an address the provider check refuses, and tells the guard that reason', async () => {
    guards();
    const tenant = createFakeTenant();
    graphWire.fetch = tenant.fetch;
    const reader = guardedContentSource({ kind: MAILBOX, provider: MAILBOX_PROVIDER.MICROSOFT }, READER_MODE.LIVE, {
      tenantId: TENANT,
      providerCheck: () => 'not_in_provider_group',
      readKey: () => SHARED_KEY,
      graphRegistration: registration,
      exclusion: NO_EXCLUSION,
    });
    await expect(read(reader.backfill(sharedSource, null))).rejects.toMatchObject({ reason: 'not_in_provider_group' });
    expect(tenant.requests).toEqual([]);
    expect(verdictCalls()).toEqual([]);
    expect(guardCalls()).toHaveLength(1);
    expect(guardCalls()[0]).toMatchObject({ p_provider_reason: 'not_in_provider_group' });
  });

  it('makes no binding request for a source of another tenant, before any guard call', async () => {
    const { rpc } = guards();
    const { reader, requests } = live(() => SHARED_KEY);
    await expect(read(reader.backfill({ ...sharedSource, tenantId: OWNER }, null))).rejects.toThrow(/another tenant/);
    expect(requests).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each(['no_consent', 'seat_inactive', 'owner_mismatch', 'source_paused'])(
    'makes no Graph request when the guard verdict denies (%s), and records the refusal through mailbox_guard_check',
    async (reason) => {
      guards({ verdict: [reason] });
      const { reader, requests } = live(() => SHARED_KEY);
      await expect(read(reader.backfill(sharedSource, null))).rejects.toMatchObject({ name: 'MailboxAccessRefusedError', reason });
      expect(requests).toEqual([]);
      expect(events).toEqual(['rpc:mailbox_guard_verdict', 'rpc:mailbox_guard_check']);
      // Recorded as today: one check call, with no provider reason, which refuses with the database's own reason.
      expect(guardCalls()).toEqual([expect.objectContaining({ p_address: FAKE_SHARED_MAILBOX.mail, p_provider_reason: null, p_purpose: 'provider_read' })]);
    },
  );

  it('makes no Graph request and no guard check when the verdict RPC fails (fail closed)', async () => {
    admin.rpc.mockImplementation(async (name: string) => {
      events.push(`rpc:${name}`);
      return name === 'mailbox_guard_verdict' ? { data: null, error: { code: 'PGRST301' } } : { data: null, error: null };
    });
    const { reader, requests } = live(() => SHARED_KEY);
    await expect(read(reader.backfill(sharedSource, null))).rejects.toThrow('mailbox guard unavailable (PGRST301)');
    expect(requests).toEqual([]);
    expect(events).toEqual(['rpc:mailbox_guard_verdict']);
  });

  it('refuses, fails closed, when the verdict denies but the check then allows (the database changed between them)', async () => {
    guards({ verdict: ['no_consent'], check: [null] });
    const { reader, requests } = live(() => SHARED_KEY);
    await expect(read(reader.backfill(sharedSource, null))).rejects.toMatchObject({ name: 'MailboxAccessRefusedError', reason: 'mirror_unavailable' });
    expect(requests).toEqual([]);
  });

  it('throws a throttled binding check with no state-writing guard call, so it is never shown as a refusal', async () => {
    guards();
    // Graph throttles every request (the client's retries included).
    graphWire.fetch = (async () => new Response(JSON.stringify({ error: { code: 'TooManyRequests' } }), { status: 429 })) as typeof fetch;
    const reader = guardedContentSource({ kind: MAILBOX, provider: MAILBOX_PROVIDER.MICROSOFT }, READER_MODE.LIVE, {
      tenantId: TENANT,
      providerCheck: inGroup,
      readKey: () => SHARED_KEY,
      graphRegistration: registration,
      exclusion: NO_EXCLUSION,
    });
    await expect(read(reader.backfill(sharedSource, null))).rejects.toMatchObject({ name: 'GraphHttpError', status: 429 });
    expect(verdictCalls()).toHaveLength(1);
    expect(guardCalls()).toEqual([]);
  });

  it('audits a binding refusal once, not on every attempt (#275 audit item 1)', async () => {
    // mailbox_guard_check as 20261001130000_mailbox_allowlist.sql writes it: an allowed call resets the state, and a
    // refusal whose reason differs from the stored one writes a discovery.mailbox_refused row.
    let lastReason: string | null = null;
    let audits = 0;
    admin.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      // The verdict writes nothing and allows: the database admits the read, the binding does not.
      if (name === 'mailbox_guard_verdict') return { data: null, error: null };
      const reason = (args.p_provider_reason as string | null) ?? null;
      if (reason === null) lastReason = null;
      else if (reason !== lastReason) {
        lastReason = reason;
        audits += 1;
      }
      return { data: reason, error: null };
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      // Each attempt is a fresh pass, as the worker builds one: the RBAC scope has not reached the mailbox yet.
      const { reader } = live(() => SHARED_KEY, { mismatchInboxById: true });
      await expect(read(reader.backfill(sharedSource, null))).rejects.toMatchObject({ reason: 'mirror_unavailable' });
    }
    expect(guardCalls()).toHaveLength(3);
    expect(verdictCalls()).toHaveLength(3);
    expect(audits).toBe(1);

    // Once the binding holds, the read goes on and the state is cleared.
    const { reader } = live(() => SHARED_KEY);
    await expect(read(reader.backfill(sharedSource, null))).resolves.toBeDefined();
    expect(lastReason).toBeNull();
    expect(audits).toBe(1);
  });

  // #643: the first read's claim (#353) hands the inner reader a copy of the source; the binding is the source's, not
  // the object's, so the copy reads under the bound UPN instead of being refused as mirror_unavailable.
  it('reads a first read the worker claims under the bound UPN, not refused', async () => {
    guards();
    const claimFirstRead = vi.fn(async () => '2026-07-17');
    const { reader, requests } = live(() => SHARED_KEY, {}, { claimFirstRead });
    const pages = await read(reader.backfill(sharedSource, null));
    expect(pages.length).toBeGreaterThan(0);
    expect(claimFirstRead).toHaveBeenCalledTimes(1);
    expect(requests.slice(0, 2)).toEqual([inbox(SHARED_KEY.id), inbox(SHARED_KEY.upn)]);
    for (const url of requests.slice(2)) {
      expect(url.startsWith(`${GRAPH}/users/deals%40bankexample.onmicrosoft.com/`)).toBe(true);
    }
    for (const call of guardCalls()) expect(call.p_provider_reason).toBeNull();
  });

  // A binding holds for the one read whose bind step made it: not for another source, and not for a later read of the
  // same one whose bind step never ran (the verdict denied, then the check allowed).
  it.each([
    ['another source', source],
    ['the same source', sharedSource],
  ])('refuses %s whose bind step did not run, after a bound read, before any mail request', async (_label, next) => {
    // The second read's verdict denies, so its bind step never runs; every check allows.
    const verdicts: Array<string | null> = [null, 'no_consent'];
    admin.rpc.mockImplementation(async (name: string) => ({ data: name === 'mailbox_guard_verdict' ? verdicts.shift() : null, error: null }));
    const { reader, requests } = live(() => SHARED_KEY);
    await expect(read(reader.backfill(sharedSource, null))).resolves.toBeDefined();
    requests.length = 0;
    await expect(read(reader.backfill(next, null))).rejects.toMatchObject({ name: 'MailboxAccessRefusedError', reason: 'mirror_unavailable' });
    expect(requests).toEqual([]);
  });

  // A read whose bind step succeeded but whose guard check then refused never opens, so its key is never taken. The
  // next read of the source must not find it when its own bind step does not run.
  it('refuses a read whose bind step did not run, after a bound read the guard check refused, before any mail request', async () => {
    // Read 1: the verdict allows and the binding holds, then the check refuses. Read 2: the verdict denies, the check allows.
    const verdicts: Array<string | null> = [null, 'no_consent'];
    const checks: Array<string | null> = ['no_consent', null];
    admin.rpc.mockImplementation(async (name: string) => ({
      data: name === 'mailbox_guard_verdict' ? verdicts.shift() : checks.shift() ?? null,
      error: null,
    }));
    const { reader, requests } = live(() => SHARED_KEY);
    await expect(read(reader.backfill(sharedSource, null))).rejects.toMatchObject({ name: 'MailboxAccessRefusedError', reason: 'no_consent' });
    expect(requests).toEqual([inbox(SHARED_KEY.id), inbox(SHARED_KEY.upn)]);
    requests.length = 0;
    await expect(read(reader.backfill(sharedSource, null))).rejects.toMatchObject({ name: 'MailboxAccessRefusedError', reason: 'mirror_unavailable' });
    expect(requests).toEqual([]);
  });

  // Two reads of one mailbox at once on one reader (#667 review): B's verdict is slow and denies, so its bind step
  // never runs; A binds meanwhile, and B's check then allows. B must not open on A's key, and A must still read.
  it('never lets a read whose bind step did not run open on the key a concurrent read of the same source bound', async () => {
    let releaseB!: (reason: string | null) => void;
    let releaseA!: (reason: string | null) => void;
    const calls: string[] = [];
    admin.rpc.mockImplementation(async (name: string) => {
      calls.push(name);
      const n = calls.length;
      // 1: B's verdict (held), 2: A's verdict (allows), 3: A's check (held), 4: B's check (allows).
      if (n === 1) return { data: await new Promise<string | null>((r) => (releaseB = r)), error: null };
      if (n === 3) return { data: await new Promise<string | null>((r) => (releaseA = r)), error: null };
      return { data: null, error: null };
    });
    const { reader, requests } = live(() => SHARED_KEY);
    const readB = read(reader.backfill(sharedSource, null));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const readA = read(reader.backfill(sharedSource, null));
    await vi.waitFor(() => expect(calls).toHaveLength(3)); // A has bound and waits on its check
    const bound = requests.length;
    releaseB('no_consent');
    await expect(readB).rejects.toMatchObject({ name: 'MailboxAccessRefusedError', reason: 'mirror_unavailable' });
    expect(requests).toHaveLength(bound); // B sent nothing
    releaseA(null);
    await expect(readA).resolves.toBeDefined();
    expect(requests.length).toBeGreaterThan(bound);
  });

  it('refuses a checkpoint whose links address another mailbox key as an unreadable checkpoint, before any mail request', async () => {
    guards();
    const { reader, requests } = live(() => SHARED_KEY);
    // Links written under the stored address, as a read before #275 would have written them.
    const stale = JSON.stringify({
      v: 1,
      kind: 'graph-mail',
      cycle: 'complete',
      folders: [{ id: 'F-IN', link: `${GRAPH}/users/deals%40bank.example/mailFolders/F-IN/messages/delta?$deltatoken=t1`, done: true }],
    });
    const error = await read(reader.delta(sharedSource, stale)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('graph mail reader: the checkpoint addresses another mailbox key');
    // The admin reads "Checkpoint unreadable" and restarts the reading.
    expect(errorSummary(error)).toBe(SYNC_ERROR.CHECKPOINT);
    expect(requests).toEqual([inbox(SHARED_KEY.id), inbox(SHARED_KEY.upn)]);
    // Not a guard refusal: the guard was asked once, and allowed.
    expect(guardCalls()).toHaveLength(1);
  });

  it('reads a live SharePoint site under the site guard, with no read key and no binding request', async () => {
    const { rpc } = guardDb([]);
    const tenant = createFakeTenant();
    graphWire.fetch = tenant.fetch;
    const reader = guardedContentSource({ kind: SOURCE_KIND.SHAREPOINT_SITE, provider: MAILBOX_PROVIDER.MICROSOFT }, READER_MODE.LIVE, {
      tenantId: TENANT,
      // A site has no group: neither is consulted.
      providerCheck: () => 'not_in_provider_group',
      readKey: () => {
        throw new Error('a site has no read key');
      },
      graphRegistration: registration,
      exclusion: NO_EXCLUSION,
    });
    const site: SourceRow = { ...siteSource, address: FAKE_SITE_ADDRESS };
    const pages = await read(reader.backfill(site, null));
    expect(pages.length).toBeGreaterThan(0);
    expect(rpc.mock.calls.map((call) => call[0])).toEqual(Array(pages.length + 1).fill('site_guard_check'));
    expect(tenant.requests.length).toBeGreaterThan(0);
    expect(tenant.requests.some((url) => url.includes('/mailFolders/') || url.includes('/users/'))).toBe(false);
  });
});

// #318: the owner's live capture reads through the worker's own guarded live read, with the responses shown to an
// observer. The binding check stays on the client's own transport; the observer sees the reader's responses only.
describe('the guarded recording session (#318)', () => {
  const GRAPH = 'https://graph.microsoft.com/v1.0';
  const MAILBOX = SOURCE_KIND.MAILBOX;
  const registration = {
    tenantId: TENANT,
    msTenantId: '44444444-4444-4444-8444-444444444444',
    clientId: '55555555-5555-4555-8555-555555555555',
    certThumbprint: 'AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01',
    certSecretRef: 'keyvault:https://bankvault.vault.azure.net/keys/reader/abc123',
  };
  const STORM = { upn: source.address, id: fakeGroupUsers().find((user) => user.mail.toLowerCase() === source.address)!.id };
  const SHARED_KEY = { upn: FAKE_SHARED_MAILBOX.upn, id: FAKE_SHARED_MAILBOX.id };
  const sharedSource: SourceRow = { ...source, id: '55555555-5555-4555-8555-555555555555', address: FAKE_SHARED_MAILBOX.mail };
  const site: SourceRow = { ...siteSource, address: FAKE_SITE_ADDRESS };
  const inbox = (key: string) => `${GRAPH}/users/${encodeURIComponent(key)}/mailFolders/inbox?$select=id`;
  const keyFor = (address: string) =>
    address === source.address ? STORM : address === FAKE_SHARED_MAILBOX.mail.toLowerCase() ? SHARED_KEY : null;
  const MICROSOFT = MAILBOX_PROVIDER.MICROSOFT;

  type Seen = { method: string; url: string; status: number; headers: Record<string, string>; responseUrl: string; body: string };

  /**
   * A recording over a fresh fake tenant. `sent` is what the transport received (url and Authorization), `seen` is
   * what the observer was shown, and `extract` stands in for the sandboxed extractor.
   */
  function recording(options: { readKey?: unknown; tenant?: FakeTenantOptions; cookie?: boolean; beforeObserve?: (count: number) => void } = {}) {
    const tenant = createFakeTenant(options.tenant);
    const sent: Array<{ url: string; authorization: string | null }> = [];
    graphWire.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization') });
      const res = await tenant.fetch(input, init);
      if (options.cookie) res.headers.append('set-cookie', 'sid=secret');
      return res;
    }) as typeof fetch;
    const seen: Seen[] = [];
    let observed = 0;
    const observe: ResponseObserver = async (request, response) => {
      observed += 1;
      options.beforeObserve?.(observed);
      const bytes = new Uint8Array(await response.arrayBuffer());
      seen.push({
        ...request,
        status: response.status,
        headers: Object.fromEntries(response.headers),
        responseUrl: response.url,
        body: new TextDecoder().decode(bytes),
      });
      return new Response(bytes.byteLength > 0 ? bytes : null, { status: response.status, headers: response.headers });
    };
    const extract = vi.fn<(bytes: Uint8Array) => Promise<{ ok: true; text: string }>>(async () => ({ ok: true as const, text: 'recorded' }));
    const session = createGuardedRecording({ observe, extract });
    const ctx = {
      tenantId: TENANT,
      providerCheck: inGroup,
      readKey: ('readKey' in options ? options.readKey : keyFor) as never,
      graphRegistration: registration,
      exclusion: NO_EXCLUSION,
    };
    return { session, ctx, sent, seen, extract, observedCount: () => observed };
  }

  async function read(pages: AsyncIterable<SourceItemPage>): Promise<SourceItemPage[]> {
    const out: SourceItemPage[] = [];
    for await (const page of pages) out.push(page);
    return out;
  }

  // The state-writing guard calls. #275 asks mailbox_guard_verdict (read-only, no audit) before a mailbox's binding
  // requests; these tests let it allow and count the decisions the guard records.
  const recordedCalls = () => admin.rpc.mock.calls.filter((call) => call[0] !== 'mailbox_guard_verdict');
  const guardCalls = () => recordedCalls().map((call) => call[1] as Record<string, unknown>);
  function guardDb(answers: Array<string | null>) {
    const queue = [...answers];
    const rpc = admin.rpc.mockImplementation(async (name: string) => ({
      data: name === 'mailbox_guard_verdict' ? null : queue.length ? queue.shift() : null,
      error: null,
    }));
    return { rpc };
  }
  const placeholderOf = (url: string) => /^https:\/\/replay\.invalid\/content\/(\d+)$/.exec(url)?.[1];

  afterEach(() => {
    graphWire.fetch = null;
  });

  it('reads as the worker reads: the guard before the first page and after each, the same pages, another caller', async () => {
    guardDb([]);
    const { session, ctx, sent, seen } = recording();
    const recorded = await read(session.sourceFor({ kind: MAILBOX, provider: MICROSOFT }, ctx).backfill(source, null));
    expect(recorded.length).toBeGreaterThan(1);
    expect(recordedCalls()).toHaveLength(recorded.length + 1);
    for (const call of guardCalls()) {
      expect(call).toMatchObject({ p_address: source.address, p_provider: 'microsoft', p_provider_reason: null, p_caller: 'm365-recorder' });
    }
    // The binding check went over the client's own transport and then the mail was read by the bound UPN.
    expect(sent.slice(0, 2).map((request) => request.url)).toEqual([inbox(STORM.id), inbox(STORM.upn)]);
    expect(seen.length).toBe(sent.length - 2);

    // The worker's read of the same tenant: the same pages, the same number of guard calls, its own caller.
    admin.rpc.mockClear();
    const tenant = createFakeTenant();
    graphWire.fetch = tenant.fetch;
    const worker = guardedContentSource({ kind: MAILBOX, provider: MICROSOFT }, READER_MODE.LIVE, ctx);
    const workerPages = await read(worker.backfill(source, null));
    expect(workerPages).toEqual(recorded);
    expect(tenant.requests.slice(0, 2)).toEqual([inbox(STORM.id), inbox(STORM.upn)]);
    expect(tenant.requests).toHaveLength(sent.length);
    expect(recordedCalls()).toHaveLength(workerPages.length + 1);
    for (const call of guardCalls()) expect(call.p_caller).toBe('discovery-worker');
  });

  // #275's order, kept by the recording door: the guard's read-only verdict first, then the binding requests, then
  // the one recorded guard check; no Graph request before an allowing verdict.
  it('asks the read-only verdict before any Graph request, and sends none when the verdict denies', async () => {
    const events: string[] = [];
    const answer = (deny: boolean) =>
      admin.rpc.mockImplementation(async (name: string) => {
        events.push(name);
        return { data: deny && name.startsWith('mailbox_guard_') ? 'no_consent' : null, error: null };
      });
    const traced = () => {
      const run = recording();
      const inner = graphWire.fetch!;
      graphWire.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        events.push(`graph ${String(input)}`);
        return inner(input, init);
      }) as typeof fetch;
      return run;
    };

    answer(false);
    const allowed = traced();
    await read(allowed.session.sourceFor({ kind: MAILBOX, provider: MICROSOFT }, allowed.ctx).backfill(source, null));
    expect(events.slice(0, 4)).toEqual([
      'mailbox_guard_verdict',
      `graph ${inbox(STORM.id)}`,
      `graph ${inbox(STORM.upn)}`,
      'mailbox_guard_check',
    ]);
    expect(events.filter((event) => event === 'mailbox_guard_verdict')).toHaveLength(1);

    events.length = 0;
    answer(true);
    const denied = traced();
    await expect(
      read(denied.session.sourceFor({ kind: MAILBOX, provider: MICROSOFT }, denied.ctx).backfill(source, null)),
    ).rejects.toMatchObject({ name: 'MailboxAccessRefusedError', reason: 'no_consent' });
    // The verdict denied, so no binding request and no mail request; the check records the refusal.
    expect(events).toEqual(['mailbox_guard_verdict', 'mailbox_guard_check']);
    expect(denied.sent).toEqual([]);
    expect(denied.seen).toEqual([]);
  });

  it('keeps the binding check out of the observer: it runs, a mismatch refuses, and no object id is shown', async () => {
    guardDb([]);
    const { session, ctx, sent, seen } = recording();
    const pages = await read(session.sourceFor({ kind: MAILBOX, provider: MICROSOFT }, ctx).backfill(sharedSource, null));
    expect(pages.length).toBeGreaterThan(0);
    expect(sent.slice(0, 2).map((request) => request.url)).toEqual([inbox(SHARED_KEY.id), inbox(SHARED_KEY.upn)]);
    expect(seen.length).toBeGreaterThan(0);
    for (const response of seen) {
      expect(response.url.startsWith(`${GRAPH}/users/deals%40bankexample.onmicrosoft.com/`)).toBe(true);
      // The reader's own folder reads (deleteditems?$select=id) are recorded; the binding check's inbox read is not.
      expect(response.url).not.toContain('/mailFolders/inbox?$select=id');
    }
    expect(seen.map((response) => response.url).join('\n')).not.toContain(SHARED_KEY.id);
    // The checkpoint the recording leaves resumes under the same key, as the worker's does.
    const token = pages.at(-1)!.nextCheckpoint!;
    const again = await read(session.sourceFor({ kind: MAILBOX, provider: MICROSOFT }, ctx).delta(sharedSource, token));
    expect(again.length).toBeGreaterThan(0);
  });

  it('refuses as mirror_unavailable, audited under the recorder, and shows the observer nothing, when the binding check fails', async () => {
    guardDb([]);
    const { session, ctx, sent, seen } = recording({ tenant: { mismatchInboxById: true } });
    await expect(read(session.sourceFor({ kind: MAILBOX, provider: MICROSOFT }, ctx).backfill(sharedSource, null))).rejects.toMatchObject({
      name: 'MailboxAccessRefusedError',
      reason: 'mirror_unavailable',
    });
    expect(sent.map((request) => request.url)).toEqual([inbox(SHARED_KEY.id), inbox(SHARED_KEY.upn)]);
    expect(seen).toEqual([]);
    // One guard call, which records the binding's answer (#275: the bind step runs before the first guard call).
    expect(recordedCalls()).toHaveLength(1);
    expect(guardCalls()[0]).toMatchObject({ p_address: FAKE_SHARED_MAILBOX.mail, p_provider_reason: 'mirror_unavailable', p_caller: 'm365-recorder' });
  });

  it.each<[string, unknown]>([
    ['missing', undefined],
    ['not a function', SHARED_KEY],
    ['a lookup that throws', () => {
      throw new Error('mirror down');
    }],
    ['no key for the address', () => null],
    ['a key with a malformed object id', () => ({ ...SHARED_KEY, id: 'id-a' })],
    ['a promise', () => Promise.resolve(SHARED_KEY)],
  ])('refuses as mirror_unavailable, audited, with no request at all, when the read key is %s', async (_label, readKey) => {
    guardDb([]);
    const { session, ctx, sent, seen } = recording({ readKey });
    await expect(read(session.sourceFor({ kind: MAILBOX, provider: MICROSOFT }, ctx).backfill(sharedSource, null))).rejects.toMatchObject({
      reason: 'mirror_unavailable',
    });
    expect(sent).toEqual([]);
    expect(seen).toEqual([]);
    expect(recordedCalls()).toHaveLength(1);
    expect(guardCalls()[0]).toMatchObject({ p_provider_reason: 'mirror_unavailable', p_caller: 'm365-recorder' });
  });

  it('stops where the worker stops: a guard refusal after page one reads no second page', async () => {
    guardDb([null, 'seat_inactive']);
    const { session, ctx } = recording();
    const pages: SourceItemPage[] = [];
    const run = async () => {
      for await (const page of session.sourceFor({ kind: MAILBOX, provider: MICROSOFT }, ctx).backfill(source, null)) pages.push(page);
    };
    await expect(run()).rejects.toMatchObject({ reason: 'seat_inactive' });
    expect(pages).toHaveLength(1);
  });

  it('shows the observer no request header, token, Set-Cookie, response url or download URL, and the reader still gets them', async () => {
    guardDb([]);
    const { session, ctx, sent, seen, extract } = recording({ cookie: true });
    const pages = await read(session.sourceFor({ kind: SOURCE_KIND.SHAREPOINT_SITE, provider: MICROSOFT }, { ...ctx, readKey: undefined }).backfill(site, null));
    // The site guard, with no read key and no binding request.
    expect(recordedCalls().map((call) => call[0])).toEqual(Array(pages.length + 1).fill('site_guard_check'));
    expect(guardCalls().every((call) => call.p_caller === 'm365-recorder')).toBe(true);
    expect(sent.some((request) => request.url.includes('/users/'))).toBe(false);
    // The reader's requests were authenticated (and the download hop was not); the observer was shown neither.
    expect(sent.filter((request) => request.url.startsWith(GRAPH)).every((request) => request.authorization === 'Bearer fake-token')).toBe(true);
    expect(sent.filter((request) => request.url.includes('download.aspx')).every((request) => request.authorization === null)).toBe(true);
    expect(seen.length).toBe(sent.length);
    for (const response of seen) {
      expect(Object.keys(response.headers)).not.toContain('authorization');
      expect(Object.keys(response.headers)).not.toContain('set-cookie');
      // Only the headers a cassette keeps: never a request id or a diagnostic header.
      expect(Object.keys(response.headers).filter((name) => !(ALLOWED_RESPONSE_HEADERS as readonly string[]).includes(name))).toEqual([]);
      expect(response.responseUrl).toBe('');
    }
    expect(JSON.stringify(seen)).not.toMatch(/fake-token|sid=secret|tempauth/);
    // Only Graph and the placeholder origin were reported: the download host never reaches the observer.
    expect(seen.map((response) => new URL(response.url).hostname).filter((host) => host !== 'graph.microsoft.com' && host !== 'replay.invalid')).toEqual([]);
    // The extractor the recording was given read the bytes the transport served.
    const documents = pages.flatMap((page) => page.documents ?? []);
    expect(documents.length).toBeGreaterThan(0);
    expect(documents.every((document) => document.text === 'recorded')).toBe(true);
    expect(Buffer.from(extract.mock.calls[0][0]).toString('latin1').startsWith('%PDF')).toBe(true);
  });

  // Graph may return a mailbox's paging links under its object id (#318 audit). The bound one is sent, and recorded,
  // under the bound UPN; any other object id is refused before it is sent.
  const BY_ID = new RegExp(`/users(?:/|\\(')${STORM.id}`, 'i');
  for (const form of ['path', 'paren'] as const) {
    it(`sends a paging link that names the bound mailbox by object id (${form} form) under its UPN, and records it so`, async () => {
      guardDb([]);
      const { session, ctx, sent, seen } = recording({ tenant: { linksByObjectId: form } });
      const reader = session.sourceFor({ kind: MAILBOX, provider: MICROSOFT }, ctx);
      const backfill = await read(reader.backfill(source, null));
      const delta = await read(reader.delta(source, backfill.at(-1)!.nextCheckpoint!));
      expect(delta.length).toBeGreaterThan(0);
      // The reader followed the links Graph gave it (its checkpoint holds the id form, which #275 accepts) ...
      expect(backfill.at(-1)!.nextCheckpoint!).toMatch(BY_ID);
      // ... and every request after the two binding checks went out under the UPN.
      const binding = [inbox(STORM.id), inbox(STORM.upn)];
      const reads = sent.map((request) => request.url).filter((url) => !binding.includes(url));
      expect(reads.length).toBeGreaterThan(0);
      expect(reads.filter((url) => BY_ID.test(decodeURIComponent(url)))).toEqual([]);
      expect(reads.some((url) => url.includes('$deltatoken='))).toBe(true);
      // The observer saw no object id, in a URL or in a page's links, and the pages' links name the UPN.
      expect(JSON.stringify(seen)).not.toContain(STORM.id);
      const links = seen.flatMap((response) => {
        const page = /json/.test(response.headers['content-type'] ?? '') ? (JSON.parse(response.body) as Record<string, unknown>) : {};
        return ['@odata.nextLink', '@odata.deltaLink'].map((name) => page[name]).filter((link): link is string => typeof link === 'string');
      });
      expect(links.length).toBeGreaterThan(0);
      expect(links.every((link) => link.startsWith(`${GRAPH}/users/${encodeURIComponent(STORM.upn)}/`))).toBe(true);
    });
  }

  it('refuses a request that names another user by object id: not sent, not observed, and every later request too', async () => {
    guardDb([]);
    const OTHER = '9f9f9f9f-1111-4222-8333-444455556666';
    const { session, ctx, sent, seen } = recording();
    const inner = graphWire.fetch!;
    // The first mail page points its nextLink at another user's object id.
    graphWire.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const res = await inner(input, init);
      if (!String(input).includes('/messages/delta?$select=')) return res;
      const page = (await res.json()) as Record<string, unknown>;
      delete page['@odata.deltaLink'];
      page['@odata.nextLink'] = `${GRAPH}/users/${OTHER}/mailFolders/x/messages/delta?$skiptoken=t`;
      return new Response(JSON.stringify(page), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    await expect(read(session.sourceFor({ kind: MAILBOX, provider: MICROSOFT }, ctx).backfill(source, null))).rejects.toThrow(
      'a request addressed a user other than the bound mailbox by object id; nothing was sent',
    );
    expect(sent.some((request) => request.url.includes(OTHER))).toBe(false);
    expect(seen.some((response) => response.url.includes(OTHER))).toBe(false);
    const count = sent.length;
    await expect(read(session.sourceFor({ kind: MAILBOX, provider: MICROSOFT }, ctx).backfill(source, null))).rejects.toThrow(/by object id/);
    expect(sent).toHaveLength(count);
  });

  it('refuses any object-id request from a site read, which has no bound mailbox', async () => {
    guardDb([]);
    const { session, ctx, sent } = recording();
    const inner = graphWire.fetch!;
    graphWire.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const res = await inner(input, init);
      if (!String(input).includes('/root/delta')) return res;
      const page = (await res.json()) as Record<string, unknown>;
      delete page['@odata.deltaLink'];
      page['@odata.nextLink'] = `${GRAPH}/users('${STORM.id}')/drive/root/delta?token=t`;
      return new Response(JSON.stringify(page), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    await expect(
      read(session.sourceFor({ kind: SOURCE_KIND.SHAREPOINT_SITE, provider: MICROSOFT }, { ...ctx, readKey: undefined }).backfill(site, null)),
    ).rejects.toThrow(/by object id/);
    expect(sent.some((request) => request.url.includes(STORM.id))).toBe(false);
  });

  it('reports each download Location, and the request that follows it, as one replay placeholder, and the reader follows the real one', async () => {
    guardDb([]);
    const { session, ctx, sent, seen } = recording();
    await read(session.sourceFor({ kind: SOURCE_KIND.SHAREPOINT_SITE, provider: MICROSOFT }, ctx).backfill(site, null));
    const hops = sent.filter((request) => request.url.includes('download.aspx'));
    expect(hops).toHaveLength(3);
    expect(new Set(hops.map((request) => request.url)).size).toBe(3);
    const redirects = seen.filter((response) => response.status === 302);
    expect(redirects).toHaveLength(3);
    for (const redirect of redirects) expect(redirect.headers.location.startsWith(`${REPLAY_ORIGIN}/content/`)).toBe(true);
    const locations = redirects.map((redirect) => redirect.headers.location);
    expect(new Set(locations).size).toBe(3);
    // The hop is reported under the placeholder its redirect was.
    const hopShown = seen.filter((response) => response.url.startsWith(REPLAY_ORIGIN));
    expect(hopShown.map((response) => response.url)).toEqual(locations);
    expect(hopShown.every((response) => response.status === 200)).toBe(true);
  });

  it('numbers placeholders across the whole recording, so two sites never share one', async () => {
    guardDb([]);
    const { session, ctx, seen } = recording();
    await read(session.sourceFor({ kind: SOURCE_KIND.SHAREPOINT_SITE, provider: MICROSOFT }, ctx).backfill(site, null));
    await read(session.sourceFor({ kind: SOURCE_KIND.SHAREPOINT_SITE, provider: MICROSOFT }, ctx).backfill({ ...site, id: '66666666-6666-4666-8666-666666666666' }, null));
    const numbers = seen.filter((response) => response.status === 302).map((response) => placeholderOf(response.headers.location));
    expect(numbers).toEqual(['1', '2', '3', '4', '5', '6']);

    // Another recording starts again at one.
    const other = recording();
    await read(other.session.sourceFor({ kind: SOURCE_KIND.SHAREPOINT_SITE, provider: MICROSOFT }, other.ctx).backfill(site, null));
    expect(placeholderOf(other.seen.find((response) => response.status === 302)!.headers.location)).toBe('1');
  });

  it('is sticky once the observer throws: a retry never sends another request, and the same error comes out', async () => {
    guardDb([]);
    const boom = new Error('observer stop');
    let sentWhenThrown = -1;
    let sentCount = () => -1;
    const { session, ctx, sent, observedCount } = recording({
      beforeObserve: (count) => {
        if (count !== 3) return;
        sentWhenThrown = sentCount();
        throw boom;
      },
    });
    sentCount = () => sent.length;
    graphWire.sleeps = 0;
    await expect(read(session.sourceFor({ kind: MAILBOX, provider: MICROSOFT }, ctx).backfill(source, null))).rejects.toBe(boom);
    // graphFetch's retry of the throwing transport stops at its first backoff: the sleep throws the observer's error
    // before waiting, so no retry reaches the transport or the observer, and nothing waits out the backoff.
    expect(sentWhenThrown).toBeGreaterThan(2);
    expect(sent).toHaveLength(sentWhenThrown);
    expect(observedCount()).toBe(3);
    expect(graphWire.sleeps).toBe(0);
  });

  it('refuses a source of another provider, and a registration-less context', () => {
    const { rpc } = guardDb([]);
    const { session, ctx } = recording();
    expect(() => session.sourceFor({ kind: MAILBOX, provider: MAILBOX_PROVIDER.GOOGLE as never }, ctx)).toThrow(/Microsoft sources only/);
    expect(() => session.sourceFor({ kind: MAILBOX, provider: MICROSOFT }, { ...ctx, graphRegistration: undefined } as never)).toThrow(
      "a live Microsoft reader needs the tenant's reader registration",
    );
    expect(rpc).not.toHaveBeenCalled();
  });

  it('keeps the caller the recorder\'s even if the context names another', async () => {
    const { rpc } = guardDb([]);
    const { session, ctx } = recording();
    await read(session.sourceFor({ kind: MAILBOX, provider: MICROSOFT }, { ...ctx, caller: 'discovery-worker' }).backfill(source, null));
    expect(rpc).toHaveBeenCalled();
    for (const call of guardCalls()) expect(call.p_caller).toBe('m365-recorder');
  });
});
