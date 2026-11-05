import { beforeEach, describe, expect, it, vi } from 'vitest';

// PL-07 (#199): a storage failure on the agent document seam must surface as an
// error. Before the fix, POST answered 200 with an in-memory receipt and GET
// served an in-memory list, so the agent believed an unsaved filing succeeded.

vi.mock('@/lib/conductia/route', () => ({
  requireConductiaLead: vi.fn(async () => ({
    ok: true,
    admin: {},
    scope: {
      tenantId: 'tn_demo',
      leadId: 'FALCO-2026-100',
      agentName: 'md-briefing',
      runId: 'run_1',
      credential: 'signed_token',
      claims: null,
    },
  })),
}));
vi.mock('@/lib/conductia/documents', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/conductia/documents')>()),
  listLeadDocuments: vi.fn(),
  persistLeadDocument: vi.fn(),
}));
vi.mock('@/lib/dataroom/steps', () => ({ loadDealByIdOrCode: vi.fn() }));
vi.mock('@/lib/dataroom/fileToStep', () => ({ fileBytesToStepDataroom: vi.fn() }));

import { GET, POST } from '@/app/v1/leads/[leadId]/documents/route';
import { listLeadDocuments, persistLeadDocument } from '@/lib/conductia/documents';

const LEAD = 'FALCO-2026-100';
const context = () => ({ params: Promise.resolve({ leadId: LEAD }) });
const dbDown = Object.assign(new Error('connection refused'), { code: '08006' });

function request(body?: unknown, query = ''): Request {
  return new Request(`http://localhost:3000/v1/leads/${LEAD}/documents${query}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('lead documents seam: storage failures are errors', () => {
  it('POST returns 5xx and no receipt when the filing cannot be persisted', async () => {
    vi.mocked(persistLeadDocument).mockRejectedValue(dbDown);
    const res = await POST(request({ title: 'MD brief', text: 'hello' }), context());
    expect(res.status).toBeGreaterThanOrEqual(500);
    const body = await res.json();
    expect(body.documentId).toBeUndefined();
    expect(body.version).toBeUndefined();
    expect(body.error).toMatchObject({ code: 'server_error' });
  });

  it('GET returns 5xx rather than a fallback list when the read fails', async () => {
    vi.mocked(listLeadDocuments).mockRejectedValue(dbDown);
    const res = await GET(request(), context());
    expect(res.status).toBeGreaterThanOrEqual(500);
    const body = await res.json();
    expect(body.documents).toBeUndefined();
    expect(body.error).toMatchObject({ code: 'server_error' });
  });

  it('GET returns an empty list when the lead has no stored documents', async () => {
    vi.mocked(listLeadDocuments).mockResolvedValue({ documents: [], nextOffset: null });
    const res = await GET(request(), context());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ documents: [], nextCursor: null });
  });
});

const brief = {
  documentId: 'doc_brief',
  tenantId: 'tn_demo',
  leadId: LEAD,
  companyId: null,
  title: 'MD brief',
  documentType: 'md_brief',
  folder: 'md-brief',
  kind: 'memo',
  originalFilename: null,
  mimeType: null,
  version: 2,
  uploadedAt: '2026-10-16T09:00:00.000Z',
  contentHash: 'sha256:3608bca1e44ea6c4d268eb6db02260269892c0b42b86bbf1e77a6fa16c3c9282',
  charLength: 3,
};

describe('lead documents seam: the list is paged and carries no text (PL-24)', () => {
  it('reads the first 200 when the caller names no page', async () => {
    vi.mocked(listLeadDocuments).mockResolvedValue({ documents: [], nextOffset: null });
    await GET(request(), context());
    expect(listLeadDocuments).toHaveBeenCalledWith({}, LEAD, { limit: 200, offset: 0 });
  });

  it('reads the page the cursor names and hands back the next cursor', async () => {
    vi.mocked(listLeadDocuments).mockResolvedValue({ documents: [brief], nextOffset: 40 });
    const res = await GET(request(undefined, '?limit=20&cursor=20'), context());
    expect(listLeadDocuments).toHaveBeenCalledWith({}, LEAD, { limit: 20, offset: 20 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      documents: [
        {
          documentId: 'doc_brief',
          leadId: LEAD,
          kind: 'memo',
          documentType: 'md_brief',
          folder: 'md-brief',
          version: 2,
          title: 'MD brief',
          contentHash: 'sha256:3608bca1e44ea6c4d268eb6db02260269892c0b42b86bbf1e77a6fa16c3c9282',
          charLength: 3,
          occurredAt: null,
          uploadedAt: '2026-10-16T09:00:00.000Z',
          uploadedBy: { kind: 'agent', agentName: 'md-briefing', runId: 'run_1' },
        },
      ],
      nextCursor: '40',
    });
  });

  it.each(['0', '201', 'ten', '-1', '2.5'])('answers 400 for limit=%s', async (limit) => {
    const res = await GET(request(undefined, `?limit=${limit}`), context());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatchObject({ code: 'validation' });
    expect(listLeadDocuments).not.toHaveBeenCalled();
  });

  it.each(['abc', '-5', 'MjA='])('answers 400 for a cursor it did not issue (%s)', async (cursor) => {
    const res = await GET(request(undefined, `?cursor=${cursor}`), context());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatchObject({ code: 'validation' });
    expect(listLeadDocuments).not.toHaveBeenCalled();
  });
});
