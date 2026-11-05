import { describe, expect, it, vi, afterEach } from 'vitest';
import { POST } from '@/app/api/skill-service/route';
import type { SkillWireRequest, SkillWireResponse } from '@/lib/orchestration/transport/wire';
import type { ContextEnvelope, TargetUniverseOutput } from '@/lib/orchestration/types';

function envelope(): ContextEnvelope {
  return {
    jobId: 'job-tu-1',
    dealId: 'deal-atlassian',
    actorId: 'actor-md',
    goal: 'Build the target universe',
    completionCondition: 'A reviewed candidate list with fixed fields exists',
    documents: [{ id: 'd-public', name: 'Market read', classification: 1, body: 'public' }],
    brief: { sellerName: 'Atlassian', sector: 'Software', headline: 'Category-defining collaboration software' },
  };
}

function wireRequest(overrides: Partial<SkillWireRequest> = {}): Request {
  const body: SkillWireRequest = {
    skill: 'target-universe',
    goal: 'Build the target universe',
    envelope: envelope(),
    completionCondition: 'A reviewed candidate list with fixed fields exists',
    model: 'economy',
    ...overrides,
  };
  return new Request('http://localhost/api/skill-service', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/skill-service (dev stub of the remote skill service)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('runs the target-universe skill and returns the wire response with reports', async () => {
    const res = await POST(wireRequest());
    expect(res.status).toBe(200);

    const body = (await res.json()) as SkillWireResponse<TargetUniverseOutput>;
    expect(body.status).toBe('complete');
    expect(body.result.candidates.length).toBeGreaterThan(0);
    expect(body.reports).toHaveLength(1);
    expect(body.reports[0].agent).toBe('TargetUniverseAgent');
    expect(body.auditRecord.saw).toEqual(['d-public']);
  });

  it('rejects an unknown skill id with 400', async () => {
    const res = await POST(wireRequest({ skill: 'nonexistent-skill' }));
    expect(res.status).toBe(400);
  });

  it('rejects a malformed body with 400', async () => {
    const res = await POST(
      new Request('http://localhost/api/skill-service', { method: 'POST', body: 'not json' }),
    );
    expect(res.status).toBe(400);
  });

  it('is absent in production (404)', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const res = await POST(wireRequest());
    expect(res.status).toBe(404);
  });
});
