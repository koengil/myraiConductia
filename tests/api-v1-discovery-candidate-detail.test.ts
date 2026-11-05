// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

const requireFlagMock = vi.hoisted(() => vi.fn());
const scopedMock = vi.hoisted(() => vi.fn());
const detailMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/v1/requireFlag', () => ({ requireFlag: requireFlagMock }));
vi.mock('@/lib/api/v1/httpScoped', () => ({ requireApiUserScoped: scopedMock }));
vi.mock('@/lib/discovery/api', () => ({ getCandidateDetail: detailMock }));

import { GET } from '@/app/api/v1/discovery/candidates/[candidateId]/route';
import { captureConsole } from './helpers/consoleCapture';

const ID = '3f0c1f0e-5a4b-4f57-9d8e-0c1f2a3b4c5d';
const call = (id: string) => GET(new Request(`http://localhost/api/v1/discovery/candidates/${id}`), { params: Promise.resolve({ candidateId: id }) });

beforeEach(() => {
  vi.clearAllMocks();
  requireFlagMock.mockResolvedValue(null);
  scopedMock.mockResolvedValue({ ok: true, user: { id: 'u-storm' }, db: { tag: 'scoped' } });
});

describe('GET /api/v1/discovery/candidates/{candidateId}', () => {
  it('404s when deal_discovery is off, before authenticating', async () => {
    requireFlagMock.mockResolvedValue(NextResponse.json({ error: 'Not found' }, { status: 404 }));
    expect((await call(ID)).status).toBe(404);
    expect(scopedMock).not.toHaveBeenCalled();
  });

  it('passes an authentication failure through (401)', async () => {
    scopedMock.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) });
    expect((await call(ID)).status).toBe(401);
    expect(detailMock).not.toHaveBeenCalled();
  });

  it('404s a non-uuid id without reading', async () => {
    const res = await call('not-a-uuid');
    expect(res.status).toBe(404);
    expect(detailMock).not.toHaveBeenCalled();
  });

  it('404s a candidate the caller cannot see, exactly as one that does not exist', async () => {
    detailMock.mockResolvedValue({ ok: true, detail: null });
    const res = await call(ID);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Proposed deal not found' });
  });

  it('reads with the caller\'s own client and answers the detail', async () => {
    const detail = { id: ID, name: 'Project Kestrel', station: null, milestones: [], evidence: [] };
    detailMock.mockResolvedValue({ ok: true, detail });
    const res = await call(ID);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ candidate: detail });
    expect(detailMock).toHaveBeenCalledWith({ tag: 'scoped' }, 'u-storm', ID);
  });

  it('500s on a read failure without the database message', async () => {
    detailMock.mockResolvedValue({ ok: false, error: 'internal detail' });
    const res = await call(ID);
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('internal detail');
  });

  it('logs the failed read as a code only, never its message (#743)', async () => {
    const capture = captureConsole();
    try {
      detailMock.mockResolvedValue({ ok: false, error: 'canceling statement: CANARY-743', code: '57014' });
      expect((await call(ID)).status).toBe(500);
      expect(capture.output()).toContain('"evt":"request_error"');
      expect(capture.output()).toContain('"method":"GET"');
      expect(capture.output()).toContain('"sqlstate":"57014"');
      expect(capture.output()).not.toContain('CANARY-743');
    } finally {
      capture.restore();
    }
  });
});
