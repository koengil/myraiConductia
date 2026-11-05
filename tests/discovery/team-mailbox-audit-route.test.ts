import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

vi.mock('@/lib/api/v1/requireFlag', () => ({ requireFlag: vi.fn() }));
vi.mock('@/lib/api/v1/httpScoped', () => ({ requireApiUserScoped: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
}));

import { requireFlag } from '@/lib/api/v1/requireFlag';
import { requireApiUserScoped } from '@/lib/api/v1/httpScoped';
import { createSupabaseAdminClient, createSupabaseServerClient } from '@/lib/supabase/server';
import {
  TEAM_MAILBOX_AUDIT_DEFAULT_LIMIT,
  TEAM_MAILBOX_AUDIT_MAX_LIMIT,
  TEAM_MAILBOX_AUDIT_VIEWS,
} from '@/lib/constants/discovery';
import { GET } from '@/app/api/v1/discovery/team-mailboxes/audit/route';

const flag = vi.mocked(requireFlag);
const scoped = vi.mocked(requireApiUserScoped);

const INBOX = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const ROW = '0b9a8c7d-6e5f-4a3b-9c2d-1e0f9a8b7c6d';
const TS = '2026-10-22T09:14:03.123456+00:00';

const page = {
  inboxes: [{ id: INBOX, address: 'deals@bank.example', open: true }],
  rows: [
    {
      id: ROW,
      ts: TS,
      action: 'discovery.team_mailbox_checked',
      actorType: 'service',
      actorName: null,
      serviceIdentity: 'discovery-worker',
      subjectName: null,
      inboxId: INBOX,
      detail: { teamMailboxId: INBOX, status: 'refused', reason: 'directory_denied' },
    },
  ],
  next: { ts: TS, id: ROW },
};

type RpcResult = { data: unknown; error: { code: string; message: string } | null };

function signedIn(result: RpcResult) {
  const rpc = vi.fn(async (): Promise<RpcResult> => result);
  scoped.mockResolvedValue({ ok: true, user: { id: 'u1', email: 'c@bank.example', companyId: null }, db: { rpc } as never });
  return rpc;
}

function refusal(code: string, message: string): RpcResult {
  return { data: null, error: { code, message } };
}

function get(query = '') {
  return GET(new Request(`http://localhost/api/v1/discovery/team-mailboxes/audit${query}`));
}

const args = (overrides: Record<string, unknown> = {}) => ({
  p_view: 'access',
  p_before_ts: null,
  p_before_id: null,
  p_limit: TEAM_MAILBOX_AUDIT_DEFAULT_LIMIT,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  flag.mockResolvedValue(null);
});

describe('GET /api/v1/discovery/team-mailboxes/audit', () => {
  it('is 404 when deal_discovery is off, and never reaches the session', async () => {
    flag.mockResolvedValue(NextResponse.json({ error: 'Not found' }, { status: 404 }));
    const res = await get();
    expect(res.status).toBe(404);
    expect(flag).toHaveBeenCalledWith('deal_discovery');
    expect(scoped).not.toHaveBeenCalled();
  });

  it('returns the scoped helper 401 when unauthenticated', async () => {
    scoped.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) });
    expect((await get()).status).toBe(401);
  });

  it('calls the audit RPC under the caller session with the default view and limit, and answers the page', async () => {
    const rpc = signedIn({ data: page, error: null });
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(page);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('discovery_team_mailbox_audit', args());
  });

  it('only ever uses the scoped client: no admin or server client is built here', async () => {
    signedIn({ data: page, error: null });
    await get('?view=reads');
    expect(createSupabaseAdminClient).not.toHaveBeenCalled();
    expect(createSupabaseServerClient).not.toHaveBeenCalled();
  });

  it.each(TEAM_MAILBOX_AUDIT_VIEWS.map((view) => [view]))('passes view=%s through', async (view) => {
    const rpc = signedIn({ data: { ...page, next: null }, error: null });
    const res = await get(`?view=${view}`);
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith('discovery_team_mailbox_audit', args({ p_view: view }));
  });

  it('passes the cursor back exactly as the RPC gave it, microseconds and offset included', async () => {
    const rpc = signedIn({ data: page, error: null });
    const before = encodeURIComponent(`${TS},${ROW}`);
    expect((await get(`?view=reads&before=${before}`)).status).toBe(200);
    expect(rpc).toHaveBeenCalledWith(
      'discovery_team_mailbox_audit',
      args({ p_view: 'reads', p_before_ts: TS, p_before_id: ROW }),
    );
  });

  it.each([['2026-10-22T09:14:03Z'], ['2028-02-29T23:59:59.5-05:00'], ['2026-10-22T00:00:00.000001+14:00']])(
    'takes a cursor at %s, a real instant with a Z or ±HH:MM offset',
    async (ts) => {
      const rpc = signedIn({ data: page, error: null });
      expect((await get(`?before=${encodeURIComponent(`${ts},${ROW}`)}`)).status).toBe(200);
      expect(rpc).toHaveBeenCalledWith('discovery_team_mailbox_audit', args({ p_before_ts: ts, p_before_id: ROW }));
    },
  );

  it.each([
    ['0', 1],
    ['-5', 1],
    ['1', 1],
    ['50', 50],
    ['200', TEAM_MAILBOX_AUDIT_MAX_LIMIT],
    ['500', TEAM_MAILBOX_AUDIT_MAX_LIMIT],
  ])('clamps limit=%s to %i', async (limit, expected) => {
    const rpc = signedIn({ data: page, error: null });
    expect((await get(`?limit=${limit}`)).status).toBe(200);
    expect(rpc).toHaveBeenCalledWith('discovery_team_mailbox_audit', args({ p_limit: expected }));
  });

  it.each([
    ['an unknown view', '?view=everything'],
    ['an empty view', '?view='],
    ['a view in another case', '?view=ACCESS'],
    ['a cursor with no id', `?before=${encodeURIComponent(TS)}`],
    ['a cursor with an empty id', `?before=${encodeURIComponent(`${TS},`)}`],
    ['a cursor with an empty timestamp', `?before=${encodeURIComponent(`,${ROW}`)}`],
    ['a cursor with three parts', `?before=${encodeURIComponent(`${TS},${ROW},x`)}`],
    ['a cursor whose id is not a uuid', `?before=${encodeURIComponent(`${TS},not-a-uuid`)}`],
    ['a cursor whose timestamp is not one', `?before=${encodeURIComponent(`yesterday,${ROW}`)}`],
    ['a cursor whose timestamp is not a real day', `?before=${encodeURIComponent(`2026-13-45T09:14:03Z,${ROW}`)}`],
    ['a cursor whose + was not encoded', `?before=2026-10-22T09:14:03.123456+00:00,${ROW}`],
    // Date.parse rolls these over to a real day; Postgres would refuse them, a 500.
    ['a cursor on 31 February', `?before=${encodeURIComponent(`2026-02-31T09:14:03Z,${ROW}`)}`],
    ['a cursor on 29 February of a common year', `?before=${encodeURIComponent(`2026-02-29T09:14:03+00:00,${ROW}`)}`],
    ['a cursor at hour 24', `?before=${encodeURIComponent(`2026-10-22T24:00:00Z,${ROW}`)}`],
    ['a cursor whose offset has no colon', `?before=${encodeURIComponent(`2026-10-22T09:14:03.123456+0000,${ROW}`)}`],
    ['a cursor whose offset has no minutes', `?before=${encodeURIComponent(`2026-10-22T09:14:03+00,${ROW}`)}`],
    ['a cursor whose offset is out of range', `?before=${encodeURIComponent(`2026-10-22T09:14:03+16:00,${ROW}`)}`],
    ['a limit that is not a number', '?limit=ten'],
    ['a limit that is not an integer', '?limit=1.5'],
    ['an empty limit', '?limit='],
  ])('is 400 for %s, and never reaches the RPC', async (_label, query) => {
    const rpc = signedIn({ data: page, error: null });
    const res = await get(query);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Bad request' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([['bad_view'], ['bad_cursor']])('answers 400 to the RPC 22023 %s', async (message) => {
    signedIn(refusal('22023', message));
    const res = await get();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Bad request' });
  });

  it('answers 404 to the RPC 42501 refusal: a caller who is not the firm admin or CCO learns nothing', async () => {
    signedIn(refusal('42501', 'not_available'));
    const res = await get();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it.each([
    ['another error', refusal('XX000', 'relation audit_log is on fire')],
    ['a 42501 with another message', refusal('42501', 'permission denied for table audit_log on fire')],
    ['a 22023 with another message', refusal('22023', 'invalid input on fire')],
  ])('answers 500 to %s, without the database message', async (_label, result) => {
    signedIn(result);
    const res = await get();
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('on fire');
  });

  it.each([
    ['null', null],
    ['a list', []],
    ['a page with no rows', { inboxes: [], next: null }],
    ['a page with no inboxes', { rows: [], next: null }],
    ['a page with no next', { inboxes: [], rows: [] }],
    ['a page with a malformed next', { inboxes: [], rows: [], next: { ts: TS } }],
  ])('answers 500 when the RPC returns %s', async (_label, data) => {
    signedIn({ data, error: null });
    expect((await get()).status).toBe(500);
  });
});

describe('the route mirrors the SQL it calls', () => {
  const sql = readFileSync(join(process.cwd(), 'supabase/migrations/20261023100300_team_mailbox_audit_read.sql'), 'utf8');

  it('accepts exactly the views the RPC accepts', () => {
    const list = /if v_view not in \(([^)]*)\) then/.exec(sql)?.[1] ?? '';
    expect([...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])).toEqual([...TEAM_MAILBOX_AUDIT_VIEWS]);
  });

  it('defaults and clamps the limit the way the RPC does', () => {
    expect(sql).toContain(
      `least(greatest(coalesce(p_limit, ${TEAM_MAILBOX_AUDIT_DEFAULT_LIMIT}), 1), ${TEAM_MAILBOX_AUDIT_MAX_LIMIT})`,
    );
    expect(sql).toMatch(new RegExp(`p_limit\\s+integer default ${TEAM_MAILBOX_AUDIT_DEFAULT_LIMIT}\\b`));
  });
});
