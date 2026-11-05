import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSkillBench, listPublicationLineage } from '@/lib/ignatious/bench';

const CONFIG = {
  baseUrl: 'https://plane.test',
  apiKey: 'key',
  tenantId: 'tenant-1',
  leadIdOverride: null,
  benchUrl: 'https://bench.test',
  conductiaBaseUrl: 'https://conductia.test',
};

const RUN_ID = '3f0d6f9a-1f4c-4a2f-9f37-2f8f2c0f6f11';

function body() {
  return {
    runId: RUN_ID,
    skill: {
      kind: 'publication' as const,
      skillId: '2d362e20-0709-4ba0-bbd7-d21831148282',
      versionId: '0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6',
      digest: 'a'.repeat(64),
    },
    projectId: '7c1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b',
    inputs: { asOf: '2026-09-30' },
    instructions: 'Short',
    tenantId: 'tenant-1',
    leadId: 'lead-1',
    token: 'jwt',
  };
}

describe('startSkillRun', () => {
  it('sends a mount binding without a projectId', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const bench = createSkillBench(CONFIG, fetchImpl as unknown as typeof fetch);

    await bench.startSkillRun({
      ...body(),
      skill: { kind: 'mount', name: 'md-briefing', version: 3, digest: 'f'.repeat(64) },
    });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).skill).toEqual({
      kind: 'mount',
      name: 'md-briefing',
      version: 3,
      digest: 'f'.repeat(64),
    });
  });

  it('posts the pinned binding and forwards the token', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const bench = createSkillBench(CONFIG, fetchImpl as unknown as typeof fetch);

    await bench.startSkillRun(body());

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://bench.test/v1/bench/skill-runs');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('key');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer jwt');
    expect((init.headers as Record<string, string>).accept).toBe('text/event-stream');
    expect(JSON.parse(init.body as string)).toEqual({
      runId: RUN_ID,
      skill: {
        kind: 'publication',
        projectId: '7c1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b',
        skillId: '2d362e20-0709-4ba0-bbd7-d21831148282',
        versionId: '0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6',
        digest: 'a'.repeat(64),
      },
      inputs: { asOf: '2026-09-30' },
      instructions: 'Short',
      input: 'Short',
      tenantId: 'tenant-1',
      leadId: 'lead-1',
      model: null,
      conductiaBaseUrl: 'https://conductia.test',
    });
  });

  it('omits the legacy input key when instructions is null', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const bench = createSkillBench(CONFIG, fetchImpl as unknown as typeof fetch);

    await bench.startSkillRun({ ...body(), instructions: null });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      runId: RUN_ID,
      skill: {
        kind: 'publication',
        projectId: '7c1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b',
        skillId: '2d362e20-0709-4ba0-bbd7-d21831148282',
        versionId: '0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6',
        digest: 'a'.repeat(64),
      },
      inputs: { asOf: '2026-09-30' },
      instructions: null,
      tenantId: 'tenant-1',
      leadId: 'lead-1',
      model: null,
      conductiaBaseUrl: 'https://conductia.test',
    });
  });

  it('never puts the token in the body', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const bench = createSkillBench(CONFIG, fetchImpl as unknown as typeof fetch);

    await bench.startSkillRun(body());

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.body as string).not.toContain('jwt');
  });

  it('omits conductiaBaseUrl when the deployment names none', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const bench = createSkillBench(
      { ...CONFIG, conductiaBaseUrl: null },
      fetchImpl as unknown as typeof fetch,
    );

    await bench.startSkillRun(body());

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).not.toHaveProperty('conductiaBaseUrl');
  });

  it('reports an unreachable bench as a 503-shaped failure', async () => {
    const bench = createSkillBench(CONFIG, (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch);

    await expect(bench.startSkillRun(body())).rejects.toMatchObject({ status: 503 });
  });
});

describe('listVersions', () => {
  it('carries a version row\'s declared input fields', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          current: 1,
          versions: [
            {
              version: 1,
              origin: 'repo',
              updatedAt: '2026-09-13T12:32:36.037Z',
              updatedBy: null,
              downloadable: true,
              current: true,
              description: null,
              status: 'ok',
              reason: null,
              sha256: null,
              contentHash: `sha256:${'a'.repeat(64)}`,
              bytesRetained: true,
              inputs: [{ name: 'asOf', type: 'date' }],
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const bench = createSkillBench(CONFIG, fetchImpl as unknown as typeof fetch);

    const { versions } = await bench.listVersions('acquirer-strategy');

    expect(versions[0].inputs[0].name).toBe('asOf');
  });

  it('defaults a version row with no declared inputs to an empty list', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          current: 1,
          versions: [
            {
              version: 1,
              origin: 'repo',
              updatedAt: '2026-09-13T12:32:36.037Z',
              updatedBy: null,
              downloadable: true,
              current: true,
              description: null,
              status: 'ok',
              reason: null,
              sha256: null,
              contentHash: `sha256:${'a'.repeat(64)}`,
              bytesRetained: true,
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const bench = createSkillBench(CONFIG, fetchImpl as unknown as typeof fetch);

    const { versions } = await bench.listVersions('acquirer-strategy');

    expect(versions[0].inputs).toEqual([]);
  });
});

describe('listPublicationLineage', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  function setConfigEnv() {
    process.env.IGNATIOUS_SKILL_BENCH_URL = 'http://localhost:4212';
    process.env.IGNATIOUS_PUBLICATION_SERVICE_TOKEN = 'pub-token';
    process.env.IGNATIOUS_API_KEY = 'api-key';
    process.env.IGNATIOUS_AUTHORING_SERVICE_TOKEN = 'authoring-token';
  }

  it('carries a lineage entry\'s declared input fields', async () => {
    setConfigEnv();
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          lineage: [
            {
              versionId: '22222222-2222-4222-8222-222222222222',
              digest: 'c'.repeat(64),
              publishedAt: '2026-09-12T00:00:00Z',
              inputs: [{ name: 'asOf', type: 'date' }],
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const lineage = await listPublicationLineage(
      '11111111-1111-4111-8111-111111111111',
      'project-1',
      fetchImpl as unknown as typeof fetch,
    );

    expect(lineage[0].inputs[0].name).toBe('asOf');
  });

  it('defaults a lineage entry with no declared inputs to an empty list', async () => {
    setConfigEnv();
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          lineage: [
            {
              versionId: '22222222-2222-4222-8222-222222222222',
              digest: 'c'.repeat(64),
              publishedAt: '2026-09-12T00:00:00Z',
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const lineage = await listPublicationLineage(
      '11111111-1111-4111-8111-111111111111',
      'project-1',
      fetchImpl as unknown as typeof fetch,
    );

    expect(lineage[0].inputs).toEqual([]);
  });
});
