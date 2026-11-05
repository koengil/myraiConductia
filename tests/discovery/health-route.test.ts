// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

const requireFlagMock = vi.hoisted(() => vi.fn());
const scopedMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/v1/requireFlag', () => ({ requireFlag: requireFlagMock }));
vi.mock('@/lib/api/v1/httpScoped', () => ({ requireApiUserScoped: scopedMock }));

import { GET } from '@/app/api/v1/discovery/health/route';

function asUser(rpc: () => Promise<{ data: unknown; error: { code: string; message: string } | null }>) {
  const db = { rpc: vi.fn(rpc) };
  scopedMock.mockResolvedValue({ ok: true, user: { id: 'u', email: 'u@bank.example' }, db });
  return db;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireFlagMock.mockResolvedValue(null);
});

describe('GET /api/v1/discovery/health', () => {
  it('404s when deal_discovery is off, before authenticating', async () => {
    requireFlagMock.mockResolvedValue(NextResponse.json({ error: 'Not found' }, { status: 404 }));
    const res = await GET();
    expect(res.status).toBe(404);
    expect(scopedMock).not.toHaveBeenCalled();
  });

  it('answers the RPC\'s health to an admin or the control room', async () => {
    const health = { registration: null, sources: [], totals: { sources: 0 } };
    const db = asUser(async () => ({ data: health, error: null }));
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ health });
    expect(db.rpc).toHaveBeenCalledWith('discovery_ingestion_health');
  });

  it('passes the per-provider registrations, allowlist, source and reconciliation fields through unchanged', async () => {
    const health = {
      registration: { status: 'active', consentedAt: null },
      registrations: [
        { provider: 'google', status: 'active', consentedAt: '2026-10-20T10:00:00Z', delegationStatus: 'missing', delegationCheckedAt: '2026-10-21T09:00:00Z' },
      ],
      allowlist: [{ provider: 'google', status: 'drift', missingCount: 2, extraCount: 0, checkedAt: '2026-10-21T09:05:00Z' }],
      viewerCanManageSources: true,
      reconciliation: 'not_built',
      sources: [{ id: 's', provider: 'google', checkpointAgeSeconds: 2400, waitingFor: 'not_in_provider_group' }],
      totals: { sources: 1 },
    };
    asUser(async () => ({ data: health, error: null }));
    const res = await GET();
    expect(await res.json()).toEqual({ health });
  });

  it('passes the exclusion counts and the current policy version through unchanged (#263)', async () => {
    const health = {
      registration: null,
      policyVersion: 2,
      sources: [{ id: 's', provider: 'google', itemsSkipped: 3, itemsExcluded: 2 }],
      totals: { sources: 1, itemsSkipped: 3, itemsExcluded: 2 },
    };
    asUser(async () => ({ data: health, error: null }));
    const res = await GET();
    expect(await res.json()).toEqual({ health });
  });

  it('answers everyone else exactly as a disabled flag does', async () => {
    asUser(async () => ({ data: null, error: { code: '42501', message: 'not available to this user' } }));
    const res = await GET();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('500s on any other failure, without the database message', async () => {
    asUser(async () => ({ data: null, error: { code: 'XX000', message: 'internal detail' } }));
    const res = await GET();
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('internal detail');
  });

  it('passes an authentication failure through', async () => {
    scopedMock.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) });
    expect((await GET()).status).toBe(401);
  });
});
