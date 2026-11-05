// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

const requireFlagMock = vi.hoisted(() => vi.fn());
const scopedMock = vi.hoisted(() => vi.fn());
const api = vi.hoisted(() => ({
  getEvidenceSuggestion: vi.fn(),
  findDealIdByCode: vi.fn(),
  dismissSuggestion: vi.fn(),
}));
vi.mock('@/lib/api/v1/requireFlag', () => ({ requireFlag: requireFlagMock }));
vi.mock('@/lib/api/v1/httpScoped', () => ({ requireApiUserScoped: scopedMock }));
vi.mock('@/lib/discovery/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/discovery/api')>()),
  ...api,
}));

import { GET } from '@/app/api/v1/discovery/suggestions/route';
import { POST as dismiss } from '@/app/api/v1/discovery/suggestions/dismiss/route';
import { dismissErrorStatus } from '@/lib/discovery/api';
import type { EvidenceSuggestion } from '@/lib/deals/evidenceSuggestion';

const DB = { tag: 'scoped' };
const ASSESSMENT = '3f0c1f0e-5a4b-4f57-9d8e-0c1f2a3b4c5d';
const DEAL_ID = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
const SUGGESTION: EvidenceSuggestion = {
  assessmentId: ASSESSMENT,
  stepId: 'p5-s51',
  reason: 'Signing / Announcement Prep because signing on Oct 26, 2026 (1 email)',
  evidenceCount: 1,
  asOf: '2026-10-28T10:00:00Z',
  dismissed: false,
  flags: [],
};

const get = (query = '?deal=KESTR-2026-412') => GET(new Request(`http://localhost/api/v1/discovery/suggestions${query}`));
const post = (body: unknown, raw?: string) =>
  dismiss(
    new Request('http://localhost/api/v1/discovery/suggestions/dismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: raw ?? JSON.stringify(body),
    }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  requireFlagMock.mockResolvedValue(null);
  scopedMock.mockResolvedValue({ ok: true, user: { id: 'u-storm' }, db: DB });
  api.getEvidenceSuggestion.mockResolvedValue({ ok: true, suggestion: SUGGESTION, origin: 'rules' });
  api.findDealIdByCode.mockResolvedValue({ ok: true, dealId: DEAL_ID });
  api.dismissSuggestion.mockResolvedValue({ ok: true, correctionId: 'corr-1' });
});

describe('GET /api/v1/discovery/suggestions', () => {
  it('404s when deal_discovery is off, before authenticating', async () => {
    requireFlagMock.mockResolvedValue(NextResponse.json({ error: 'Not found' }, { status: 404 }));
    expect((await get()).status).toBe(404);
    expect(scopedMock).not.toHaveBeenCalled();
    expect(api.getEvidenceSuggestion).not.toHaveBeenCalled();
  });

  it('passes an authentication failure through (401) and never offers an admin client', async () => {
    scopedMock.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) });
    expect((await get()).status).toBe(401);
    expect(api.getEvidenceSuggestion).not.toHaveBeenCalled();
  });

  it('400s a missing or oversized deal code', async () => {
    expect((await get('')).status).toBe(400);
    expect((await get('?deal=%20')).status).toBe(400);
    expect((await get(`?deal=${'x'.repeat(65)}`)).status).toBe(400);
    expect(api.getEvidenceSuggestion).not.toHaveBeenCalled();
  });

  it("reads the caller's own scoped client for the deal code", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ suggestion: SUGGESTION, origin: 'rules' });
    expect(api.getEvidenceSuggestion).toHaveBeenCalledWith(DB, 'KESTR-2026-412');
  });

  it('carries the origin of a deal the model found, as the enum and nothing behind it', async () => {
    api.getEvidenceSuggestion.mockResolvedValue({ ok: true, suggestion: SUGGESTION, origin: 'model_proposal' });
    const res = await get();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ suggestion: SUGGESTION, origin: 'model_proposal' });
    expect(JSON.stringify(body)).not.toMatch(/cluster|model:u:/);
  });

  it('answers null when the deal has no assessment or the caller cannot read it', async () => {
    api.getEvidenceSuggestion.mockResolvedValue({ ok: true, suggestion: null, origin: 'rules' });
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ suggestion: null, origin: 'rules' });
  });

  it('500s a failed origin read, never answering origin rules', async () => {
    api.getEvidenceSuggestion.mockResolvedValue({ ok: false, error: 'origin_unavailable' });
    const res = await get();
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('origin');
    expect(JSON.stringify(body)).not.toMatch(/rules|origin_unavailable/);
  });

  it('500s a failed read without leaking its message', async () => {
    api.getEvidenceSuggestion.mockResolvedValue({ ok: false, error: 'relation stage_assessments does not exist' });
    const res = await get();
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toMatch(/stage_assessments/);
  });
});

describe('POST /api/v1/discovery/suggestions/dismiss', () => {
  const valid = { dealCode: 'KESTR-2026-412', assessmentId: ASSESSMENT, reason: ' Signing slipped to November ' };

  it('404s when deal_discovery is off, and 401s an unauthenticated caller', async () => {
    requireFlagMock.mockResolvedValue(NextResponse.json({ error: 'Not found' }, { status: 404 }));
    expect((await post(valid)).status).toBe(404);
    requireFlagMock.mockResolvedValue(null);
    scopedMock.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) });
    expect((await post(valid)).status).toBe(401);
    expect(api.dismissSuggestion).not.toHaveBeenCalled();
  });

  it.each([
    ['a body that is not JSON', undefined, '{nope'],
    ['a body that is not an object', 'text', undefined],
    ['no deal code', { ...valid, dealCode: undefined }, undefined],
    ['an assessment id that is not a uuid', { ...valid, assessmentId: 'latest' }, undefined],
    ['a blank reason', { ...valid, reason: '   ' }, undefined],
    ['no reason', { ...valid, reason: undefined }, undefined],
    ['an oversized reason', { ...valid, reason: 'x'.repeat(1001) }, undefined],
  ])('400s %s without calling the RPC', async (_label, body, raw) => {
    expect((await post(body, raw)).status).toBe(400);
    expect(api.dismissSuggestion).not.toHaveBeenCalled();
  });

  it('404s a deal the caller cannot read, before calling the RPC', async () => {
    api.findDealIdByCode.mockResolvedValue({ ok: true, dealId: null });
    expect((await post(valid)).status).toBe(404);
    expect(api.dismissSuggestion).not.toHaveBeenCalled();
  });

  it('dismisses with the trimmed reason on the caller\'s scoped client', async () => {
    const res = await post(valid);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ correctionId: 'corr-1' });
    expect(api.findDealIdByCode).toHaveBeenCalledWith(DB, 'KESTR-2026-412');
    expect(api.dismissSuggestion).toHaveBeenCalledWith(DB, DEAL_ID, ASSESSMENT, 'Signing slipped to November');
  });

  it.each([
    ['42501', 403],
    ['P0002', 404],
    ['55P03', 409],
    ['22023', 400],
    [undefined, 500],
  ])('maps SQLSTATE %s to %i', async (code, status) => {
    api.dismissSuggestion.mockResolvedValue({ ok: false, code });
    const res = await post(valid);
    expect(res.status).toBe(status);
    expect(((await res.json()) as { error: string }).error).toBe(dismissErrorStatus(code).error);
  });

  it('tells the caller only the MD may dismiss, never that a deal exists', () => {
    expect(dismissErrorStatus('42501').error).toBe('Only the deal MD can dismiss this suggestion');
  });
});
