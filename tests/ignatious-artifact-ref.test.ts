import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * #331: a run artifact is addressed by its index in the run's artifact list,
 * never by its file path, so the URL carries ids and an integer and nothing the
 * upstream named. The routes resolve the path server-side through
 * plane.getRun(executionId).artifacts[n].path and then fetch as before. The
 * link stays a plain GET, so the briefing's <a href> download keeps working.
 */

const gate = vi.hoisted(() => ({
  getRun: vi.fn(),
  getArtifact: vi.fn(),
  belongsToDeal: vi.fn(),
  belongsToCompany: vi.fn(),
}));

vi.mock('@/lib/ignatious/routeContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ignatious/routeContext')>();
  const plane = { getRun: gate.getRun, getArtifact: gate.getArtifact };
  return {
    ...actual,
    requireIgnatiousDeal: vi.fn(async () => ({
      ok: true,
      ctx: { admin: {}, deal: { id: 'deal-1', code: 'D-1', tenantId: 't-1' }, plane },
    })),
    requireIgnatiousCompany: vi.fn(async () => ({
      ok: true,
      ctx: { admin: {}, company: { id: 'co-1', name: 'Co', tenantId: 't-1' }, plane },
    })),
    executionBelongsToDeal: gate.belongsToDeal,
    executionBelongsToCompany: gate.belongsToCompany,
  };
});

import { GET as dealArtifact } from '@/app/api/v1/deals/[dealId]/steps/[stepId]/ignatious/artifacts/route';
import { GET as presearchArtifact } from '@/app/api/v1/companies/[companyId]/presearch/artifacts/route';
import { artifactUrl, presearchArtifactUrl } from '@/lib/ignatious/client';

const ARTIFACTS = [
  { path: 'brief.md', kind: 'document', primary: true, bytes: 100 },
  { path: 'notes/sources.json', kind: 'structured', primary: false, bytes: 40 },
];

const dealCtx = { params: Promise.resolve({ dealId: 'deal-1', stepId: 'p1-s9' }) };
const companyCtx = { params: Promise.resolve({ companyId: 'co-1' }) };

const dealGet = (query: string) =>
  dealArtifact(new Request(`http://localhost/api/v1/deals/deal-1/steps/p1-s9/ignatious/artifacts?${query}`), dealCtx);
const presearchGet = (query: string) =>
  presearchArtifact(new Request(`http://localhost/api/v1/companies/co-1/presearch/artifacts?${query}`), companyCtx);

beforeEach(() => {
  vi.clearAllMocks();
  gate.belongsToDeal.mockResolvedValue(true);
  gate.belongsToCompany.mockResolvedValue(true);
  gate.getRun.mockResolvedValue({ executionId: 'exec-1', artifacts: ARTIFACTS });
  gate.getArtifact.mockImplementation(
    async () => new Response('# brief', { status: 200, headers: { 'content-type': 'text/markdown' } }),
  );
});

describe('artifact URLs', () => {
  it('address the artifact by index and never carry a path', () => {
    const dealUrl = artifactUrl('deal-1', 'exec-1', 1);
    expect(dealUrl).toBe('/api/v1/deals/deal-1/steps/p1-s9/ignatious/artifacts?executionId=exec-1&artifact=1');
    const companyUrl = presearchArtifactUrl('co-1', 'exec-1', 0);
    expect(companyUrl).toBe('/api/v1/companies/co-1/presearch/artifacts?executionId=exec-1&artifact=0');
    for (const url of [dealUrl, companyUrl]) {
      expect(url).not.toMatch(/[?&]path=/);
      expect(url).not.toContain('brief.md');
    }
  });
});

describe.each([
  ['deal step artifact route', dealGet, 'belongsToDeal' as const],
  ['presearch artifact route', presearchGet, 'belongsToCompany' as const],
])('%s', (_name, get, binder) => {
  it('resolves artifact=<n> through getRun and fetches that path', async () => {
    const response = await get('executionId=exec-1&artifact=1');
    expect(response.status).toBe(200);
    expect(gate.getRun).toHaveBeenCalledWith('exec-1');
    expect(gate.getArtifact).toHaveBeenCalledWith('exec-1', 'notes/sources.json');
    expect(await response.text()).toBe('# brief');
    expect(response.headers.get('content-type')).toBe('text/markdown');
  });

  it('refuses a path parameter, so a file path can never ride in the URL', async () => {
    const response = await get('executionId=exec-1&path=brief.md');
    expect(response.status).toBe(400);
    expect(gate.getRun).not.toHaveBeenCalled();
    expect(gate.getArtifact).not.toHaveBeenCalled();

    const both = await get('executionId=exec-1&artifact=0&path=brief.md');
    expect(both.status).toBe(400);
    expect(gate.getArtifact).not.toHaveBeenCalled();
  });

  it('answers 404 for an index past the end of the run artifacts', async () => {
    const response = await get('executionId=exec-1&artifact=2');
    expect(response.status).toBe(404);
    expect(gate.getArtifact).not.toHaveBeenCalled();
  });

  it.each(['abc', '-1', '1.5', '', '01x'])('answers 400 for artifact=%j', async (value) => {
    const response = await get(`executionId=exec-1&artifact=${value}`);
    expect(response.status).toBe(400);
    expect(gate.getArtifact).not.toHaveBeenCalled();
  });

  it('answers 400 without an executionId or artifact', async () => {
    expect((await get('artifact=0')).status).toBe(400);
    expect((await get('executionId=exec-1')).status).toBe(400);
  });

  it('serves an upstream text/html as an opaque download, never as a document (#226)', async () => {
    gate.getArtifact.mockImplementation(
      async () => new Response('<script>1</script>', { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    const response = await get('executionId=exec-1&artifact=0');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(response.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('keeps the run binding: a run on another deal or lead is a 404 before any lookup', async () => {
    gate[binder].mockResolvedValue(false);
    const response = await get('executionId=exec-other&artifact=0');
    expect(response.status).toBe(404);
    expect(gate.getRun).not.toHaveBeenCalled();
    expect(gate.getArtifact).not.toHaveBeenCalled();
  });
});

describe('deal step artifact route download name', () => {
  it('names the attachment from the resolved artifact path, not from the request', async () => {
    const response = await dealGet('executionId=exec-1&artifact=1');
    expect(response.headers.get('content-disposition')).toBe(
      `attachment; filename="sources.json"; filename*=UTF-8''sources.json`,
    );
  });
});
