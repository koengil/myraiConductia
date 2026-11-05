// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

const requireFlagMock = vi.hoisted(() => vi.fn());
const scopedMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/v1/requireFlag', () => ({ requireFlag: requireFlagMock }));
vi.mock('@/lib/api/v1/httpScoped', () => ({ requireApiUserScoped: scopedMock }));

import { POST } from '@/app/api/v1/discovery/model-proposals/accept/route';
import { acceptModelProposal, modelProposalAcceptErrorStatus } from '@/lib/discovery/api';
import { proposedStepFor } from '@/lib/discovery/propose/station';

// A model-named key: its slug comes from a mail-derived name, so it must never leave the server (R12).
const NAME = 'Project Falcon';
const SLUG = 'project-falcon';
const KEY = `m:${SLUG}`;
const CANDIDATE_KEY = 'c:3e4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6071';
const OPERATION = '6f1e2d3c-4b5a-4c6d-8e7f-9a0b1c2d3e4f';
const STEP = proposedStepFor('phase-2');

/** What the RPC answers: a one-row table. */
const answered = (count = 2, operation: unknown = OPERATION) => ({
  data: [{ operation_id: operation, request_count: count }],
  error: null,
});

/** The caller's scoped client: only rpc is reached, and it answers as the RPC would. */
function scopedDb(answer: { data: unknown; error: { code?: string; message?: string } | null }) {
  const rpc = vi.fn().mockResolvedValue(answer);
  return { db: { rpc }, rpc };
}

const post = (body: unknown, raw?: string) =>
  POST(
    new Request('http://localhost/api/v1/discovery/model-proposals/accept', {
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

describe('POST /api/v1/discovery/model-proposals/accept', () => {
  it('404s when deal_discovery is off, before authenticating', async () => {
    requireFlagMock.mockImplementation(async (key: string) =>
      key === 'deal_discovery' ? NextResponse.json({ error: 'Not found' }, { status: 404 }) : null,
    );
    expect((await post({ dealKey: KEY, proposedStepId: STEP })).status).toBe(404);
    expect(scopedMock).not.toHaveBeenCalled();
  });

  it('404s when the demo flag is off, before authenticating', async () => {
    requireFlagMock.mockImplementation(async (key: string) =>
      key === 'discovery_model_proposals_demo' ? NextResponse.json({ error: 'Not found' }, { status: 404 }) : null,
    );
    expect((await post({ dealKey: KEY, proposedStepId: STEP })).status).toBe(404);
    expect(requireFlagMock).toHaveBeenCalledWith('deal_discovery');
    expect(requireFlagMock).toHaveBeenCalledWith('discovery_model_proposals_demo');
    expect(scopedMock).not.toHaveBeenCalled();
  });

  it('passes an authentication failure through', async () => {
    scopedMock.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) });
    expect((await post({ dealKey: KEY, proposedStepId: STEP })).status).toBe(401);
  });

  it.each([
    ['a body that is not JSON', undefined, '{"dealKey":'],
    ['an array', [KEY], undefined],
    ['no key', { proposedStepId: STEP }, undefined],
    ['a key that is not a string', { dealKey: 7, proposedStepId: STEP }, undefined],
    ['a name instead of a key', { dealKey: NAME, proposedStepId: STEP }, undefined],
    ['a key of the wrong shape', { dealKey: `m:${NAME}`, proposedStepId: STEP }, undefined],
    ['a candidate key, which has nothing to accept', { dealKey: CANDIDATE_KEY, proposedStepId: STEP }, undefined],
    ['an over-long slug', { dealKey: `m:${'a'.repeat(65)}`, proposedStepId: STEP }, undefined],
    ['no station', { dealKey: KEY }, undefined],
    ['a station that is not a string', { dealKey: KEY, proposedStepId: 21 }, undefined],
    ['a station of the wrong shape', { dealKey: KEY, proposedStepId: 'Station 21' }, undefined],
    ['a station outside phases 1 to 5', { dealKey: KEY, proposedStepId: 'p6-s1' }, undefined],
  ])('400s for %s, without asking the database', async (_label, body, raw) => {
    const { db, rpc } = scopedDb(answered());
    scopedMock.mockResolvedValue({ ok: true, user: { id: 'u-storm' }, db });
    const res = await post(body, raw);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Check the fields and try again' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("records the accept on the caller's own session and answers 202 with the reference and the requests written", async () => {
    const { db, rpc } = scopedDb(answered(2));
    scopedMock.mockResolvedValue({ ok: true, user: { id: 'u-storm' }, db });
    const res = await post({ dealKey: KEY, proposedStepId: STEP });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ operationId: OPERATION, requestCount: 2 });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('discovery_accept_model_proposal', { p_deal_key: KEY, p_proposed_step_id: STEP });
  });

  it('answers 202 with the same reference and 0 for a repeat or a second tab', async () => {
    const { db } = scopedDb(answered(0));
    scopedMock.mockResolvedValue({ ok: true, user: { id: 'u-storm' }, db });
    const res = await post({ dealKey: KEY, proposedStepId: STEP });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ operationId: OPERATION, requestCount: 0 });
  });

  it('reads the RPC answer as a one-row table or as a row', async () => {
    const { db } = scopedDb({ data: { operation_id: OPERATION, request_count: 1 }, error: null });
    expect(await acceptModelProposal(db as never, KEY, STEP)).toEqual({ ok: true, operationId: OPERATION, requestCount: 1 });
  });

  it.each([
    ['an empty answer', { data: [], error: null }],
    ['no answer', { data: null, error: null }],
    ['a reference that is not a uuid', answered(1, KEY)],
    ['a reference that is missing', answered(1, null)],
  ])('500s without a code for %s, and passes on nothing', async (_label, answer) => {
    const { db } = scopedDb(answer);
    scopedMock.mockResolvedValue({ ok: true, user: { id: 'u-storm' }, db });
    const res = await post({ dealKey: KEY, proposedStepId: STEP });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Could not accept the proposal' });
  });

  it.each([
    ['P0002', 404, { error: 'Proposal not found' }],
    ['55P03', 409, { error: 'Try again in a moment' }],
    ['55000', 409, { error: 'This proposal can no longer be accepted', code: 'candidate_closed' }],
    ['42501', 403, { error: 'Needs deal-create authority' }],
    ['22023', 400, { error: 'Check the fields and try again' }],
    ['XX000', 500, { error: 'Could not accept the proposal' }],
    [undefined, 500, { error: 'Could not accept the proposal' }],
  ])('maps SQLSTATE %s to %i with a fixed text', async (code, status, body) => {
    expect(modelProposalAcceptErrorStatus(code)).toMatchObject({ status, error: body.error });
    const { db } = scopedDb({ data: null, error: { code, message: 'refused' } });
    scopedMock.mockResolvedValue({ ok: true, user: { id: 'u-storm' }, db });
    const res = await post({ dealKey: KEY, proposedStepId: STEP });
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual(body);
  });

  it('tells a closed candidate from the lock timeout, though both are 409', async () => {
    const closed = scopedDb({ data: null, error: { code: '55000' } });
    scopedMock.mockResolvedValue({ ok: true, user: { id: 'u-storm' }, db: closed.db });
    expect(await (await post({ dealKey: KEY, proposedStepId: STEP })).json()).toMatchObject({ code: 'candidate_closed' });
    const busy = scopedDb({ data: null, error: { code: '55P03' } });
    scopedMock.mockResolvedValue({ ok: true, user: { id: 'u-storm' }, db: busy.db });
    expect(await (await post({ dealKey: KEY, proposedStepId: STEP })).json()).not.toHaveProperty('code');
  });

  it('answers a stale proposal (the station is no longer the group\'s) with 409 proposal_changed, logging nothing', async () => {
    const stale = scopedDb({ data: null, error: { code: '22023', message: 'invalid_proposed_step' } });
    scopedMock.mockResolvedValue({ ok: true, user: { id: 'u-storm' }, db: stale.db });
    const res = await post({ dealKey: KEY, proposedStepId: STEP });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'This proposal changed. Review it again.', code: 'proposal_changed' });
    // Any other 22023 (a bad key, too many rows) stays the plain 400.
    const bad = scopedDb({ data: null, error: { code: '22023', message: 'too_many_proposals' } });
    scopedMock.mockResolvedValue({ ok: true, user: { id: 'u-storm' }, db: bad.db });
    expect((await post({ dealKey: KEY, proposedStepId: STEP })).status).toBe(400);
    expect(logs).toEqual([]);
  });

  it('logs an unexpected failure through the content-free logger, with the SQLSTATE only (audit D8)', async () => {
    const { db } = scopedDb({ data: null, error: { code: '57014', message: `internal ${KEY}` } });
    scopedMock.mockResolvedValue({ ok: true, user: { id: 'u-storm' }, db });
    await post({ dealKey: KEY, proposedStepId: STEP });
    expect(logs.map((line) => JSON.parse(line))).toEqual([
      { evt: 'request_error', routeType: 'route', method: 'POST', errorClass: 'db', status: 500, sqlstate: '57014' },
    ]);
  });

  it("writes a SQLSTATE outside the logger's closed set as invalid", async () => {
    const { db } = scopedDb({ data: null, error: { code: 'XX000', message: 'internal' } });
    scopedMock.mockResolvedValue({ ok: true, user: { id: 'u-storm' }, db });
    await post({ dealKey: KEY, proposedStepId: STEP });
    expect(JSON.parse(logs[0])).toMatchObject({ evt: 'request_error', sqlstate: 'invalid' });
  });

  it('logs nothing for a refusal that is not a failure of ours', async () => {
    for (const code of ['P0002', '55P03', '55000', '42501', '22023']) {
      const { db } = scopedDb({ data: null, error: { code, message: 'refused' } });
      scopedMock.mockResolvedValue({ ok: true, user: { id: 'u-storm' }, db });
      await post({ dealKey: KEY, proposedStepId: STEP });
    }
    expect(logs).toEqual([]);
  });

  describe('R12: the key never leaves the server', () => {
    // A database message that quotes the key, as PostgREST can quote the input that failed.
    const quoting = { message: `accept failed for ${KEY} (${NAME})` };
    const leaks = (text: string) => [KEY, SLUG, NAME, 'falcon'].filter((s) => text.toLowerCase().includes(s.toLowerCase()));

    it.each(['P0002', '55P03', '55000', '42501', '22023', 'XX000', undefined])(
      'SQLSTATE %s: neither the body nor a log line carries it',
      async (code) => {
        const { db } = scopedDb({ data: null, error: { code, ...quoting } });
        scopedMock.mockResolvedValue({ ok: true, user: { id: 'u-storm' }, db });
        const res = await post({ dealKey: KEY, proposedStepId: STEP });
        expect(leaks(await res.text())).toEqual([]);
        expect(leaks(logs.join('\n'))).toEqual([]);
      },
    );

    it('a success: the answer is the reference and a count, no key', async () => {
      const { db } = scopedDb(answered(1));
      scopedMock.mockResolvedValue({ ok: true, user: { id: 'u-storm' }, db });
      const res = await post({ dealKey: KEY, proposedStepId: STEP });
      expect(Object.keys(await res.clone().json()).sort()).toEqual(['operationId', 'requestCount']);
      expect(leaks(await res.text())).toEqual([]);
      expect(leaks(logs.join('\n'))).toEqual([]);
    });

    it.each([
      ['a refused shape', { dealKey: `m:${NAME}`, proposedStepId: STEP }, undefined],
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
