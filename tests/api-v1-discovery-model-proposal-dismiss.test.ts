// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

const requireFlagMock = vi.hoisted(() => vi.fn());
const scopedMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/v1/requireFlag', () => ({ requireFlag: requireFlagMock }));
vi.mock('@/lib/api/v1/httpScoped', () => ({ requireApiUserScoped: scopedMock }));

import { POST } from '@/app/api/v1/discovery/model-proposals/dismiss/route';
import { modelProposalDismissErrorStatus } from '@/lib/discovery/api';

// A model-named key: its slug comes from a mail-derived name, so it must never leave the server (R12).
const NAME = 'Project Falcon';
const SLUG = 'project-falcon';
const KEY = `m:${SLUG}`;
const CANDIDATE_KEY = 'c:3e4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6071';
const OPERATION = '6f1e2d3c-4b5a-4c6d-8e7f-9a0b1c2d3e4f';

/** The caller's scoped client: only rpc is reached, and it answers as the RPC would. */
function scopedDb(answer: { data: unknown; error: { code?: string; message?: string } | null }) {
  const rpc = vi.fn().mockResolvedValue(answer);
  return { db: { rpc }, rpc };
}

const post = (body: unknown, raw?: string) =>
  POST(
    new Request('http://localhost/api/v1/discovery/model-proposals/dismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: raw ?? JSON.stringify(body),
    }),
  );

let logs: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  requireFlagMock.mockResolvedValue(null);
  logs = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /api/v1/discovery/model-proposals/dismiss', () => {
  it('404s when deal_discovery is off, before authenticating', async () => {
    requireFlagMock.mockImplementation(async (key: string) =>
      key === 'deal_discovery' ? NextResponse.json({ error: 'Not found' }, { status: 404 }) : null,
    );
    expect((await post({ dealKey: KEY })).status).toBe(404);
    expect(scopedMock).not.toHaveBeenCalled();
  });

  it('404s when the demo flag is off, before authenticating', async () => {
    requireFlagMock.mockImplementation(async (key: string) =>
      key === 'discovery_model_proposals_demo' ? NextResponse.json({ error: 'Not found' }, { status: 404 }) : null,
    );
    expect((await post({ dealKey: KEY })).status).toBe(404);
    expect(requireFlagMock).toHaveBeenCalledWith('deal_discovery');
    expect(requireFlagMock).toHaveBeenCalledWith('discovery_model_proposals_demo');
    expect(scopedMock).not.toHaveBeenCalled();
  });

  it('passes an authentication failure through', async () => {
    scopedMock.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) });
    expect((await post({ dealKey: KEY })).status).toBe(401);
  });

  it.each([
    ['a body that is not JSON', undefined, '{"dealKey":'],
    ['an array', [KEY], undefined],
    ['no key', {}, undefined],
    ['a key that is not a string', { dealKey: 7 }, undefined],
    ['a name instead of a key', { dealKey: NAME }, undefined],
    ['a key of the wrong shape', { dealKey: `m:${NAME}` }, undefined],
    ['a candidate key that is not a uuid', { dealKey: 'c:kestrel' }, undefined],
    ['an over-long slug', { dealKey: `m:${'a'.repeat(65)}` }, undefined],
  ])('400s for %s, without asking the database', async (_label, body, raw) => {
    const { db, rpc } = scopedDb({ data: { dismissed: 1, operationId: OPERATION }, error: null });
    scopedMock.mockResolvedValue({ ok: true, user: { id: 'u-storm' }, db });
    const res = await post(body, raw);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Check the fields and try again' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([KEY, CANDIDATE_KEY])("dismisses %s on the caller's own session and answers the rows written and the reference", async (dealKey) => {
    const { db, rpc } = scopedDb({ data: { dismissed: 2, operationId: OPERATION }, error: null });
    scopedMock.mockResolvedValue({ ok: true, user: { id: 'u-storm' }, db });
    const res = await post({ dealKey });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ dismissed: 2, operationId: OPERATION });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('discovery_dismiss_model_proposal', { p_deal_key: dealKey });
  });

  it('answers 0 and no reference for a repeat or a second tab, where every row was already dismissed', async () => {
    const { db } = scopedDb({ data: { dismissed: 0, operationId: null }, error: null });
    scopedMock.mockResolvedValue({ ok: true, user: { id: 'u-storm' }, db });
    const res = await post({ dealKey: KEY });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ dismissed: 0, operationId: null });
  });

  it('passes on only a uuid as the reference', async () => {
    const { db } = scopedDb({ data: { dismissed: 1, operationId: 'm:project-heron' }, error: null });
    scopedMock.mockResolvedValue({ ok: true, user: { id: 'u-storm' }, db });
    const res = await post({ dealKey: KEY });
    expect(await res.json()).toEqual({ dismissed: 1, operationId: null });
  });

  it.each([
    ['P0002', 404, 'Proposal not found'],
    ['55P03', 409, 'Try again in a moment'],
    ['42501', 401, 'Unauthorized'],
    ['22023', 400, 'Check the fields and try again'],
    ['XX000', 500, 'Could not dismiss the proposal'],
    [undefined, 500, 'Could not dismiss the proposal'],
  ])('maps SQLSTATE %s to %i with a fixed text', async (code, status, error) => {
    expect(modelProposalDismissErrorStatus(code)).toEqual({ status, error });
    const { db } = scopedDb({ data: null, error: { code, message: 'refused' } });
    scopedMock.mockResolvedValue({ ok: true, user: { id: 'u-storm' }, db });
    const res = await post({ dealKey: KEY });
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error });
  });

  it('logs an unexpected failure through the content-free logger, with the SQLSTATE only (audit D8)', async () => {
    const { db } = scopedDb({ data: null, error: { code: '57014', message: `internal ${KEY}` } });
    scopedMock.mockResolvedValue({ ok: true, user: { id: 'u-storm' }, db });
    await post({ dealKey: KEY });
    expect(logs.map((line) => JSON.parse(line))).toEqual([
      { evt: 'request_error', routeType: 'route', method: 'POST', errorClass: 'db', status: 500, sqlstate: '57014' },
    ]);
  });

  it("writes a SQLSTATE outside the logger's closed set as invalid", async () => {
    const { db } = scopedDb({ data: null, error: { code: 'XX000', message: 'internal' } });
    scopedMock.mockResolvedValue({ ok: true, user: { id: 'u-storm' }, db });
    await post({ dealKey: KEY });
    expect(JSON.parse(logs[0])).toMatchObject({ evt: 'request_error', sqlstate: 'invalid' });
  });

  describe('R12: the key never leaves the server', () => {
    // A database message that quotes the key, as PostgREST can quote the input that failed.
    const quoting = { message: `dismiss failed for ${KEY} (${NAME})` };
    const leaks = (text: string) => [KEY, SLUG, NAME, 'falcon'].filter((s) => text.toLowerCase().includes(s.toLowerCase()));

    it.each(['P0002', '55P03', '42501', '22023', 'XX000', undefined])(
      'SQLSTATE %s: neither the body nor a log line carries it',
      async (code) => {
        const { db } = scopedDb({ data: null, error: { code, ...quoting } });
        scopedMock.mockResolvedValue({ ok: true, user: { id: 'u-storm' }, db });
        const res = await post({ dealKey: KEY });
        expect(leaks(await res.text())).toEqual([]);
        expect(leaks(logs.join('\n'))).toEqual([]);
      },
    );

    it.each([
      ['a refused shape', { dealKey: `m:${NAME}` }, undefined],
      ['a broken body', undefined, `{"dealKey":"${KEY}"`],
    ])('%s: neither the body nor a log line carries it', async (_label, body, raw) => {
      const { db } = scopedDb({ data: 1, error: null });
      scopedMock.mockResolvedValue({ ok: true, user: { id: 'u-storm' }, db });
      const res = await post(body, raw);
      expect(leaks(await res.text())).toEqual([]);
      expect(leaks(logs.join('\n'))).toEqual([]);
    });
  });
});
