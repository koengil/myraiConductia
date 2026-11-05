import { NextResponse } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/v1/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/v1/http')>();
  return { ...actual, requireApiUser: vi.fn() };
});

vi.mock('@/lib/api/v1/setupWalkthroughs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/v1/setupWalkthroughs')>();
  return { ...actual, resolveSetupActor: vi.fn() };
});

vi.mock('@/lib/api/v1/requireFlag', () => ({
  isFlagEnabled: vi.fn(),
  requireFlag: vi.fn(),
}));
vi.mock('@/lib/box/types', () => ({ isBoxConfigured: vi.fn() }));
vi.mock('@/lib/email/graph', () => ({ graphConfigured: vi.fn() }));
vi.mock('@/lib/storage', () => ({ resolveStorageProvider: vi.fn() }));

import { GET } from '@/app/api/v1/setup/route';
import { PATCH } from '@/app/api/v1/setup/walkthroughs/[track]/route';
import { requireApiUser } from '@/lib/api/v1/http';
import { isFlagEnabled, requireFlag } from '@/lib/api/v1/requireFlag';
import { resolveSetupActor } from '@/lib/api/v1/setupWalkthroughs';
import { isBoxConfigured } from '@/lib/box/types';
import { graphConfigured } from '@/lib/email/graph';
import { resolveStorageProvider } from '@/lib/storage';

type Result = { data: unknown; error: { message: string } | null };

function makeAdmin(tables: Record<string, Result | Result[]>, rpcResult?: Result) {
  const tableCalls: string[] = [];
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const from = (table: string) => {
    tableCalls.push(table);
    const configured = tables[table];
    const result = Array.isArray(configured)
      ? (configured.shift() ?? { data: null, error: null })
      : (configured ?? { data: null, error: null });
    const builder: Record<string, unknown> = {};
    const filters: Array<[string, unknown]> = [];
    builder.select = () => builder;
    builder.eq = (column: string, value: unknown) => {
      filters.push([column, value]);
      return builder;
    };
    // A single stored row answers only when every .eq() on a column it carries
    // matches, as PostgREST would; a row without that column is not filtered.
    builder.maybeSingle = () => {
      const row = result.data as Record<string, unknown> | null;
      const matches =
        !row || filters.every(([column, value]) => !(column in row) || row[column] === value);
      return Promise.resolve(matches ? result : { data: null, error: result.error });
    };
    builder.then = (resolve: (value: Result) => unknown) => Promise.resolve(result).then(resolve);
    return builder;
  };
  const rpc = (name: string, args: Record<string, unknown>) => {
    rpcCalls.push({ name, args });
    return Promise.resolve(rpcResult ?? { data: null, error: null });
  };
  return { admin: { from, rpc }, tableCalls, rpcCalls };
}

function authenticate(admin: ReturnType<typeof makeAdmin>['admin']) {
  vi.mocked(requireApiUser).mockResolvedValue({
    ok: true,
    user: { id: 'u-1', email: 'user@bank.test' },
    admin,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

beforeEach(() => {
  vi.mocked(requireFlag).mockResolvedValue(null);
  vi.mocked(isFlagEnabled).mockResolvedValue(true);
});

afterEach(() => {
  vi.clearAllMocks();
});

it('keeps both setup routes fail-closed when the rollout flag is off', async () => {
  vi.mocked(requireFlag).mockResolvedValue(
    NextResponse.json({ error: 'Not found' }, { status: 404 }),
  );

  const getResponse = await GET();
  const patchResponse = await PATCH(
    new Request('http://localhost/api/v1/setup/walkthroughs/user', {
      method: 'PATCH',
      body: JSON.stringify({
        contentVersion: 1,
        expectedRevision: 0,
        completedStepIds: [],
      }),
    }),
    { params: Promise.resolve({ track: 'user' }) },
  );

  expect(getResponse.status).toBe(404);
  expect(patchResponse.status).toBe(404);
  expect(requireApiUser).not.toHaveBeenCalled();
});

describe('GET /api/v1/setup', () => {
  it('returns role-aware walkthroughs and connection readiness', async () => {
    const { admin } = makeAdmin({
      setup_walkthrough_progress: {
        data: [
          {
            track: 'user',
            content_version: 1,
            revision: 2,
            completed_steps: ['data_security'],
            completed_at: null,
          },
        ],
        error: null,
      },
      mailbox_connections: {
        data: { email: 'user@bank.test', connected_at: '2026-08-14T20:00:00Z' },
        error: null,
      },
    });
    authenticate(admin);
    vi.mocked(resolveSetupActor).mockResolvedValue({
      ok: true,
      actor: { firmRole: 'admin', companyId: null, companyRole: null, isExternal: false },
      tracks: ['user', 'administrator'],
    });
    vi.mocked(isFlagEnabled).mockResolvedValue(true);
    vi.mocked(graphConfigured).mockReturnValue(true);
    vi.mocked(isBoxConfigured).mockReturnValue(true);
    vi.mocked(resolveStorageProvider).mockReturnValue('box');

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.integrations.microsoft_365).toMatchObject({
      configured: true,
      connected: true,
      email: 'user@bank.test',
    });
    expect(body.integrations.box).toEqual({ eligible: true, configured: true, active: true });
    expect(body.walkthroughs.map((item: { track: string }) => item.track)).toEqual([
      'user',
      'administrator',
    ]);
    expect(body.walkthroughs[0]).toMatchObject({ revision: 2, completed_step_ids: ['data_security'] });
  });

  it('reads only the Microsoft mailbox row, so a Google sending connection is not Microsoft 365', async () => {
    const { admin } = makeAdmin({
      setup_walkthrough_progress: { data: [], error: null },
      mailbox_connections: {
        data: { email: 'user@bank.test', connected_at: '2026-10-17T10:00:00Z', provider: 'google' },
        error: null,
      },
    });
    authenticate(admin);
    vi.mocked(resolveSetupActor).mockResolvedValue({
      ok: true,
      actor: { firmRole: null, companyId: 'c-1', companyRole: 'member', isExternal: false },
      tracks: ['user'],
    });
    vi.mocked(isFlagEnabled).mockResolvedValue(true);
    vi.mocked(graphConfigured).mockReturnValue(true);
    vi.mocked(isBoxConfigured).mockReturnValue(false);
    vi.mocked(resolveStorageProvider).mockReturnValue('local');

    const body = await (await GET()).json();
    expect(body.integrations.microsoft_365).toMatchObject({
      configured: true,
      connected: false,
      email: null,
      connected_at: null,
    });
  });

  it('keeps external accounts on the user track without querying a mailbox', async () => {
    const { admin, tableCalls } = makeAdmin({
      setup_walkthrough_progress: { data: [], error: null },
    });
    authenticate(admin);
    vi.mocked(resolveSetupActor).mockResolvedValue({
      ok: true,
      actor: { firmRole: null, companyId: null, companyRole: null, isExternal: true },
      tracks: ['user'],
    });
    vi.mocked(isFlagEnabled).mockResolvedValue(true);
    vi.mocked(graphConfigured).mockReturnValue(true);
    vi.mocked(isBoxConfigured).mockReturnValue(true);
    vi.mocked(resolveStorageProvider).mockReturnValue('local');

    const body = await (await GET()).json();
    expect(body.walkthroughs).toHaveLength(1);
    expect(body.integrations.microsoft_365).toMatchObject({
      eligible: false,
      configured: false,
      connected: false,
    });
    expect(body.integrations.box).toEqual({
      eligible: false,
      configured: false,
      active: false,
    });
    expect(tableCalls).not.toContain('mailbox_connections');
    expect(isFlagEnabled).not.toHaveBeenCalled();
    expect(isBoxConfigured).not.toHaveBeenCalled();
    expect(resolveStorageProvider).not.toHaveBeenCalled();
  });

  it('fails closed when setup authority cannot be resolved', async () => {
    const { admin } = makeAdmin({});
    authenticate(admin);
    vi.mocked(resolveSetupActor).mockResolvedValue({ ok: false, reason: 'unreadable' });
    expect((await GET()).status).toBe(503);
  });
});

describe('PATCH /api/v1/setup/walkthroughs/{track}', () => {
  const context = (track: string) => ({ params: Promise.resolve({ track }) });
  const request = (body: unknown) =>
    new Request('http://localhost/api/v1/setup/walkthroughs/user', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('normalizes and persists an exact progress set through the RPC', async () => {
    const { admin, rpcCalls } = makeAdmin({}, {
      data: {
        track: 'user',
        content_version: 1,
        revision: 2,
        completed_steps: ['data_security', 'communications_screening'],
        completed_at: null,
      },
      error: null,
    });
    authenticate(admin);
    vi.mocked(resolveSetupActor).mockResolvedValue({
      ok: true,
      actor: { firmRole: null, companyId: 'c-1', companyRole: 'member', isExternal: false },
      tracks: ['user'],
    });

    const response = await PATCH(
      request({
        contentVersion: 1,
        expectedRevision: 1,
        completedStepIds: ['communications_screening', 'data_security'],
      }),
      context('user'),
    );

    expect(response.status).toBe(200);
    expect(rpcCalls).toEqual([
      {
        name: 'update_setup_walkthrough_progress',
        args: {
          p_actor_id: 'u-1',
          p_track: 'user',
          p_content_version: 1,
          p_expected_revision: 1,
          p_completed_steps: ['data_security', 'communications_screening'],
        },
      },
    ]);
  });

  it('rejects unknown, duplicate, and administrator-only progress', async () => {
    const { admin, rpcCalls } = makeAdmin({});
    authenticate(admin);
    vi.mocked(resolveSetupActor).mockResolvedValue({
      ok: true,
      actor: { firmRole: null, companyId: 'c-1', companyRole: 'member', isExternal: false },
      tracks: ['user'],
    });

    expect(
      (
        await PATCH(
          request({ contentVersion: 1, expectedRevision: 0, completedStepIds: ['unknown'] }),
          context('user'),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await PATCH(
          request({
            contentVersion: 1,
            expectedRevision: 0,
            completedStepIds: ['data_security', 'data_security'],
          }),
          context('user'),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await PATCH(
          request({ contentVersion: 1, expectedRevision: 0, completedStepIds: [] }),
          context('administrator'),
        )
      ).status,
    ).toBe(403);
    expect(rpcCalls).toHaveLength(0);
  });

  it('maps stale writes and immutable completion failures to conflicts', async () => {
    const { admin } = makeAdmin({}, {
      data: null,
      error: { message: 'stale_revision' },
    });
    authenticate(admin);
    vi.mocked(resolveSetupActor).mockResolvedValue({
      ok: true,
      actor: { firmRole: null, companyId: null, companyRole: null, isExternal: true },
      tracks: ['user'],
    });
    const response = await PATCH(
      request({ contentVersion: 1, expectedRevision: 1, completedStepIds: [] }),
      context('user'),
    );
    expect(response.status).toBe(409);
  });
});
