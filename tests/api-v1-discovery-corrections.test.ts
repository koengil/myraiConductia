// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

const requireFlagMock = vi.hoisted(() => vi.fn());
const scopedMock = vi.hoisted(() => vi.fn());
const wrappers = vi.hoisted(() => ({
  renameCandidate: vi.fn(),
  rejectCandidate: vi.fn(),
  setStation: vi.fn(),
  mergeCandidates: vi.fn(),
  splitCandidate: vi.fn(),
  reassignLink: vi.fn(),
}));
vi.mock('@/lib/api/v1/requireFlag', () => ({ requireFlag: requireFlagMock }));
vi.mock('@/lib/api/v1/httpScoped', () => ({ requireApiUserScoped: scopedMock }));
vi.mock('@/lib/discovery/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/discovery/api')>()),
  ...wrappers,
}));

import { correctionErrorStatus } from '@/lib/discovery/api';
import { POST as merge } from '@/app/api/v1/discovery/candidates/[candidateId]/merge/route';
import { POST as reassign } from '@/app/api/v1/discovery/candidates/[candidateId]/reassign/route';
import { POST as reject } from '@/app/api/v1/discovery/candidates/[candidateId]/reject/route';
import { POST as rename } from '@/app/api/v1/discovery/candidates/[candidateId]/rename/route';
import { POST as split } from '@/app/api/v1/discovery/candidates/[candidateId]/split/route';
import { POST as station } from '@/app/api/v1/discovery/candidates/[candidateId]/station/route';

const ID = '3f0c1f0e-5a4b-4f57-9d8e-0c1f2a3b4c5d';
const OTHER = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
const LINK = '5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e';
const ITEM_1 = '11111111-1111-4111-8111-111111111111';
const ITEM_2 = '22222222-2222-4222-8222-222222222222';
const DB = { tag: 'scoped' };

type Handler = typeof rename;
const call = (handler: Handler, body: unknown, id: string = ID, raw?: string) =>
  handler(
    new Request(`http://localhost/api/v1/discovery/candidates/${id}/x`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: raw ?? JSON.stringify(body),
    }),
    { params: Promise.resolve({ candidateId: id }) },
  );

const ROUTES: Array<{
  name: string;
  handler: Handler;
  wrapper: keyof typeof wrappers;
  valid: Record<string, unknown>;
  args: unknown[];
}> = [
  { name: 'rename', handler: rename, wrapper: 'renameCandidate', valid: { name: ' Project Kestrel ', reason: ' r ' }, args: [DB, ID, 'Project Kestrel', 'r'] },
  { name: 'reject', handler: reject, wrapper: 'rejectCandidate', valid: { reason: ' Not a deal ' }, args: [DB, ID, 'Not a deal'] },
  { name: 'station', handler: station, wrapper: 'setStation', valid: { stepId: 'p4-s48', reason: 'Signed' }, args: [DB, ID, 'p4-s48', 'Signed'] },
  { name: 'merge', handler: merge, wrapper: 'mergeCandidates', valid: { survivorId: OTHER, reason: 'Same' }, args: [DB, ID, OTHER, 'Same'] },
  {
    name: 'split',
    handler: split,
    wrapper: 'splitCandidate',
    valid: { itemIds: [ITEM_1, ITEM_2, ITEM_1], name: ' Project Annex ', reason: ' Different ' },
    args: [DB, ID, [ITEM_1, ITEM_2], 'Project Annex', 'Different'],
  },
  {
    name: 'reassign',
    handler: reassign,
    wrapper: 'reassignLink',
    valid: { linkId: LINK, targetCandidateId: OTHER, reason: ' Wrong deal ' },
    args: [DB, ID, LINK, OTHER, 'Wrong deal'],
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  requireFlagMock.mockResolvedValue(null);
  scopedMock.mockResolvedValue({ ok: true, user: { id: 'u-storm' }, db: DB });
  for (const fn of Object.values(wrappers)) fn.mockResolvedValue({ ok: true, correctionId: 'corr-1' });
});

describe.each(ROUTES)('POST /api/v1/discovery/candidates/{id}/$name', ({ handler, wrapper, valid, args }) => {
  it('404s when deal_discovery is off, before authenticating or reading the body', async () => {
    requireFlagMock.mockResolvedValue(NextResponse.json({ error: 'Not found' }, { status: 404 }));
    expect((await call(handler, valid)).status).toBe(404);
    expect(scopedMock).not.toHaveBeenCalled();
    expect(wrappers[wrapper]).not.toHaveBeenCalled();
  });

  it('passes an authentication failure through (401)', async () => {
    scopedMock.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) });
    expect((await call(handler, valid)).status).toBe(401);
    expect(wrappers[wrapper]).not.toHaveBeenCalled();
  });

  it('404s a non-uuid id without calling the RPC', async () => {
    expect((await call(handler, valid, 'not-a-uuid')).status).toBe(404);
    expect(wrappers[wrapper]).not.toHaveBeenCalled();
  });

  it('400s a body that is not JSON, or not an object', async () => {
    expect((await call(handler, null, ID, '{nope')).status).toBe(400);
    expect((await call(handler, ['x'])).status).toBe(400);
    expect((await call(handler, 'text')).status).toBe(400);
    expect(wrappers[wrapper]).not.toHaveBeenCalled();
  });

  it("calls the RPC wrapper with the caller's own client and the trimmed fields, and answers the correction id", async () => {
    const res = await call(handler, valid);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ correctionId: 'corr-1' });
    expect(wrappers[wrapper]).toHaveBeenCalledWith(...args);
  });

  it.each([
    ['42501', 403, 'Needs deal-create authority'],
    ['P0002', 404, 'Proposed deal not found'],
    ['55000', 409, 'This proposed deal can no longer be changed'],
    ['55P03', 409, 'Discovery is updating this deal. Try again in a moment.'],
    ['22023', 400, 'Check the fields and try again'],
    ['XX000', 500, 'The change could not be saved'],
  ])('maps the RPC error %s to %i', async (code, status, error) => {
    wrappers[wrapper].mockResolvedValue({ ok: false, code });
    const res = await call(handler, valid);
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error });
  });
});

describe('body validation', () => {
  it('rename needs a name of 1 to 120 characters, and a reason that is text when given', async () => {
    expect((await call(rename, {})).status).toBe(400);
    expect((await call(rename, { name: '   ' })).status).toBe(400);
    expect((await call(rename, { name: 'x'.repeat(121) })).status).toBe(400);
    expect((await call(rename, { name: 'Ok', reason: 5 })).status).toBe(400);
    expect((await call(rename, { name: 'Ok', reason: '  ' })).status).toBe(400);
    expect(wrappers.renameCandidate).not.toHaveBeenCalled();
    expect((await call(rename, { name: 'Ok' })).status).toBe(200);
    expect(wrappers.renameCandidate).toHaveBeenCalledWith(DB, ID, 'Ok', null);
  });

  it('reject needs a reason', async () => {
    expect((await call(reject, {})).status).toBe(400);
    expect((await call(reject, { reason: '  ' })).status).toBe(400);
    expect((await call(reject, { reason: 'x'.repeat(1001) })).status).toBe(400);
    expect(wrappers.rejectCandidate).not.toHaveBeenCalled();
  });

  it('station needs a reason and a step of the MVP rail', async () => {
    expect((await call(station, { reason: 'Why' })).status).toBe(400);
    expect((await call(station, { stepId: 'p4-s48' })).status).toBe(400);
    expect((await call(station, { stepId: 'p9-s99', reason: 'Why' })).status).toBe(400);
    expect((await call(station, { stepId: 'LOI Review', reason: 'Why' })).status).toBe(400);
    expect((await call(station, { stepId: 7, reason: 'Why' })).status).toBe(400);
    expect(wrappers.setStation).not.toHaveBeenCalled();
  });

  it('merge needs a survivor uuid and a reason', async () => {
    expect((await call(merge, { reason: 'Why' })).status).toBe(400);
    expect((await call(merge, { survivorId: 'not-a-uuid', reason: 'Why' })).status).toBe(400);
    expect((await call(merge, { survivorId: OTHER })).status).toBe(400);
    expect(wrappers.mergeCandidates).not.toHaveBeenCalled();
  });
});

describe('split and reassign', () => {
  it('split needs uuid item ids, a name and a reason', async () => {
    const ok = { itemIds: [ITEM_1], name: 'Annex', reason: 'Why' };
    expect((await call(split, { ...ok, itemIds: [] })).status).toBe(400);
    expect((await call(split, { ...ok, itemIds: 'x' })).status).toBe(400);
    expect((await call(split, { ...ok, itemIds: [ITEM_1, 'not-a-uuid'] })).status).toBe(400);
    expect((await call(split, { ...ok, itemIds: [ITEM_1, 7] })).status).toBe(400);
    expect((await call(split, { ...ok, itemIds: Array.from({ length: 501 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`) })).status).toBe(400);
    expect((await call(split, { ...ok, name: '   ' })).status).toBe(400);
    expect((await call(split, { ...ok, name: 'x'.repeat(121) })).status).toBe(400);
    expect((await call(split, { ...ok, reason: '' })).status).toBe(400);
    expect((await call(split, { itemIds: [ITEM_1], name: 'Annex' })).status).toBe(400);
    expect(wrappers.splitCandidate).not.toHaveBeenCalled();
    expect((await call(split, ok)).status).toBe(200);
  });

  it('reassign needs a link uuid, a target uuid and a reason', async () => {
    const ok = { linkId: LINK, targetCandidateId: OTHER, reason: 'Why' };
    expect((await call(reassign, { ...ok, linkId: 'x' })).status).toBe(400);
    expect((await call(reassign, { ...ok, targetCandidateId: 'x' })).status).toBe(400);
    expect((await call(reassign, { ...ok, reason: ' ' })).status).toBe(400);
    expect((await call(reassign, { linkId: LINK, reason: 'Why' })).status).toBe(400);
    expect(wrappers.reassignLink).not.toHaveBeenCalled();
    expect((await call(reassign, ok)).status).toBe(200);
  });

  it.each([
    [split, 'splitCandidate', '22023', 'nothing_left', 400, 'Leave at least one email on this proposed deal'],
    [split, 'splitCandidate', '22023', 'not_visible_result', 400, 'Choose emails you can open, so the new proposed deal is yours to see'],
    [split, 'splitCandidate', '22023', 'link_not_live', 409, 'One of these emails has already moved'],
    [reassign, 'reassignLink', '42501', 'owner_not_seated', 403, "Only the deal team's own mail can join this deal"],
  ] as const)('tells the refusals that share a SQLSTATE apart by the RPC message: %#', async (handler, wrapper, code, message, status, error) => {
    wrappers[wrapper].mockResolvedValue({ ok: false, code, message });
    const valid = handler === split ? { itemIds: [ITEM_1], name: 'A', reason: 'Why' } : { linkId: LINK, targetCandidateId: OTHER, reason: 'Why' };
    const res = await call(handler, valid);
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error });
  });
});

describe('correctionErrorStatus', () => {
  it('never carries a database message', () => {
    expect(correctionErrorStatus(undefined)).toEqual({ status: 500, error: 'The change could not be saved' });
    expect(correctionErrorStatus('23505')).toEqual({ status: 500, error: 'The change could not be saved' });
    // A message that is not one of the known refusals is ignored, never echoed.
    expect(correctionErrorStatus('22023', 'relation "deal_candidates" violates something')).toEqual({
      status: 400,
      error: 'Check the fields and try again',
    });
    expect(correctionErrorStatus('42501', 'permission denied for table corrections')).toEqual({
      status: 403,
      error: 'Needs deal-create authority',
    });
  });
});
