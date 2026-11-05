import { afterEach, describe, expect, it, vi } from 'vitest';

import { leadIdForDeal, readIgnatiousConfig, resolveConductiaPublicUrl } from '@/lib/ignatious/config';
import { createControlPlane, IgnatiousRequestError } from '@/lib/ignatious/control-plane';
import { mdBriefingScopes, mintTriggerToken, readTriggerClaims } from '@/lib/ignatious/jwt';

describe('mintTriggerToken', () => {
  it('emits a three-part JWT with the claims Ignatious forwards', () => {
    const token = mintTriggerToken({
      conductiaTenantId: 'tenant-a',
      agentName: 'md-briefing',
      dealId: 'lead-001',
      scopes: mdBriefingScopes(),
      userId: 'u-1',
      userEmail: 'ada@conductia.dev',
    });
    expect(readTriggerClaims(`Bearer ${token}`)).toMatchObject({
      agentName: 'md-briefing',
      dealId: 'lead-001',
      userId: 'u-1',
      userEmail: 'ada@conductia.dev',
    });
    const [, payload] = token.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
      iss: string;
      agentName: string;
      dealId: string;
      scopes: string[];
      userEmail: string;
    };
    expect(claims.iss).toBe('conductia');
    expect(claims.agentName).toBe('md-briefing');
    expect(claims.dealId).toBe('lead-001');
    expect(claims.scopes).toContain('lead.read');
    expect(claims.scopes).toContain('documents.write');
    expect(claims.userEmail).toBe('ada@conductia.dev');
  });
});

describe('readIgnatiousConfig', () => {
  const prev = { ...process.env };

  afterEach(() => {
    process.env = { ...prev };
  });

  it('returns null when the control plane URL or key is missing', () => {
    delete process.env.IGNATIOUS_CONTROL_PLANE_URL;
    delete process.env.IGNATIOUS_API_URL;
    delete process.env.IGNATIOUS_API_KEY;
    expect(readIgnatiousConfig()).toBeNull();
  });

  it('reads the local demo defaults and maps a deal onto the override lead', () => {
    delete process.env.IGNATIOUS_API_URL;
    delete process.env.IGNATIOUS_SKILL_BENCH_URL;
    delete process.env.CONDUCTIA_PUBLIC_URL;
    delete process.env.VERCEL_URL;
    delete process.env.VERCEL_ENV;
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    process.env.IGNATIOUS_CONTROL_PLANE_URL = 'http://localhost:4111/';
    process.env.IGNATIOUS_API_KEY = 'local-dev-key';
    process.env.IGNATIOUS_TENANT_ID = 'tn_demo';
    process.env.IGNATIOUS_LEAD_ID = 'lead-001';
    const config = readIgnatiousConfig();
    expect(config).toMatchObject({
      baseUrl: 'http://localhost:4111',
      apiKey: 'local-dev-key',
      tenantId: 'tn_demo',
      leadIdOverride: 'lead-001',
      benchUrl: 'http://localhost:4111',
      conductiaBaseUrl: null,
    });
    expect(leadIdForDeal(config!, { id: 'uuid', code: 'FALCO-2026-100' })).toBe('lead-001');
  });

  it('maps a deal onto its own code when no lead override is set', () => {
    process.env.IGNATIOUS_CONTROL_PLANE_URL = 'http://localhost:4111';
    process.env.IGNATIOUS_API_KEY = 'local-dev-key';
    delete process.env.IGNATIOUS_LEAD_ID;
    const config = readIgnatiousConfig();
    expect(config?.leadIdOverride).toBeNull();
    expect(leadIdForDeal(config!, { id: 'uuid', code: 'FALCO-2026-100' })).toBe('FALCO-2026-100');
  });

  it('uses one public hostname for both halves when only IGNATIOUS_API_URL is set', () => {
    delete process.env.IGNATIOUS_CONTROL_PLANE_URL;
    delete process.env.IGNATIOUS_SKILL_BENCH_URL;
    process.env.IGNATIOUS_API_URL = 'https://api.conductia-prototype.com/';
    process.env.IGNATIOUS_API_KEY = 'deploy-key';
    process.env.CONDUCTIA_PUBLIC_URL = 'https://app.conductia.com';
    expect(readIgnatiousConfig()).toMatchObject({
      baseUrl: 'https://api.conductia-prototype.com',
      benchUrl: 'https://api.conductia-prototype.com',
      apiKey: 'deploy-key',
      conductiaBaseUrl: 'https://app.conductia.com',
    });
  });

  it('keeps a local bench override when the two processes are separate', () => {
    process.env.IGNATIOUS_CONTROL_PLANE_URL = 'http://localhost:4111';
    process.env.IGNATIOUS_SKILL_BENCH_URL = 'http://localhost:4212';
    process.env.IGNATIOUS_API_KEY = 'local-dev-key';
    expect(readIgnatiousConfig()?.benchUrl).toBe('http://localhost:4212');
  });

  it('omits the callback origin on a preview deploy so Ignatious does not 403', () => {
    delete process.env.CONDUCTIA_PUBLIC_URL;
    delete process.env.IGNATIOUS_CONTROL_PLANE_URL;
    delete process.env.IGNATIOUS_SKILL_BENCH_URL;
    process.env.IGNATIOUS_API_URL = 'https://api.conductia-prototype.com';
    process.env.IGNATIOUS_API_KEY = 'deploy-key';
    process.env.VERCEL_ENV = 'preview';
    process.env.VERCEL_PROJECT_PRODUCTION_URL = 'app.conductia.com';
    process.env.VERCEL_URL = 'conductia-git-feat-bench-acme.vercel.app';
    expect(readIgnatiousConfig()?.conductiaBaseUrl).toBeNull();
  });

  it('uses the Vercel project custom domain on a production deploy', () => {
    delete process.env.CONDUCTIA_PUBLIC_URL;
    delete process.env.IGNATIOUS_CONTROL_PLANE_URL;
    delete process.env.IGNATIOUS_SKILL_BENCH_URL;
    delete process.env.IGNATIOUS_LEAD_ID;
    process.env.IGNATIOUS_API_URL = 'https://api.conductia-prototype.com';
    process.env.IGNATIOUS_API_KEY = 'deploy-key';
    process.env.IGNATIOUS_TENANT_ID = 'tn_demo';
    process.env.VERCEL_ENV = 'production';
    process.env.VERCEL_PROJECT_PRODUCTION_URL = 'app.conductia.com';
    process.env.VERCEL_URL = 'conductia-abc123.vercel.app';
    expect(readIgnatiousConfig()?.conductiaBaseUrl).toBe('https://app.conductia.com');
  });

  it('refuses the tn_demo fallback on a production deploy', () => {
    delete process.env.IGNATIOUS_CONTROL_PLANE_URL;
    delete process.env.IGNATIOUS_LEAD_ID;
    delete process.env.IGNATIOUS_TENANT_ID;
    process.env.IGNATIOUS_API_URL = 'https://api.conductia-prototype.com';
    process.env.IGNATIOUS_API_KEY = 'deploy-key';
    process.env.VERCEL_ENV = 'production';
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(readIgnatiousConfig()).toBeNull();
    expect(errorSpy).toHaveBeenCalledOnce();
    errorSpy.mockRestore();
  });

  it('accepts tn_demo on a production deploy when it is set explicitly', () => {
    delete process.env.IGNATIOUS_CONTROL_PLANE_URL;
    delete process.env.IGNATIOUS_LEAD_ID;
    process.env.IGNATIOUS_API_URL = 'https://api.conductia-prototype.com';
    process.env.IGNATIOUS_API_KEY = 'deploy-key';
    process.env.IGNATIOUS_TENANT_ID = 'tn_demo';
    process.env.VERCEL_ENV = 'production';
    expect(readIgnatiousConfig()?.tenantId).toBe('tn_demo');
  });

  it('keeps the tn_demo fallback on a preview deploy', () => {
    delete process.env.IGNATIOUS_CONTROL_PLANE_URL;
    delete process.env.IGNATIOUS_TENANT_ID;
    process.env.IGNATIOUS_API_URL = 'https://api.conductia-prototype.com';
    process.env.IGNATIOUS_API_KEY = 'deploy-key';
    process.env.VERCEL_ENV = 'preview';
    expect(readIgnatiousConfig()?.tenantId).toBe('tn_demo');
  });

  it('refuses the lead override on a production deploy', () => {
    delete process.env.IGNATIOUS_CONTROL_PLANE_URL;
    process.env.IGNATIOUS_API_URL = 'https://api.conductia-prototype.com';
    process.env.IGNATIOUS_API_KEY = 'deploy-key';
    process.env.IGNATIOUS_LEAD_ID = 'lead-001';
    process.env.VERCEL_ENV = 'production';
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(readIgnatiousConfig()).toBeNull();
    expect(errorSpy).toHaveBeenCalledOnce();
    errorSpy.mockRestore();
  });

  it('keeps the lead override on a preview deploy', () => {
    delete process.env.IGNATIOUS_CONTROL_PLANE_URL;
    process.env.IGNATIOUS_API_URL = 'https://api.conductia-prototype.com';
    process.env.IGNATIOUS_API_KEY = 'deploy-key';
    process.env.IGNATIOUS_LEAD_ID = 'lead-001';
    process.env.VERCEL_ENV = 'preview';
    const config = readIgnatiousConfig();
    expect(config?.leadIdOverride).toBe('lead-001');
    expect(leadIdForDeal(config!, { id: 'uuid', code: 'FALCO-2026-100' })).toBe('lead-001');
  });
});

describe('resolveConductiaPublicUrl', () => {
  it('prefers CONDUCTIA_PUBLIC_URL over the Vercel host', () => {
    expect(
      resolveConductiaPublicUrl({
        CONDUCTIA_PUBLIC_URL: 'https://app.conductia.com/',
        VERCEL_URL: 'conductia-abc.vercel.app',
      }),
    ).toBe('https://app.conductia.com');
  });

  it('does not send a preview *.vercel.app host', () => {
    expect(
      resolveConductiaPublicUrl({
        VERCEL_ENV: 'preview',
        VERCEL_URL: 'preview-123.vercel.app',
      }),
    ).toBeNull();
  });

  it('uses VERCEL_PROJECT_PRODUCTION_URL only when VERCEL_ENV is production', () => {
    expect(
      resolveConductiaPublicUrl({
        VERCEL_ENV: 'production',
        VERCEL_PROJECT_PRODUCTION_URL: 'app.conductia.com',
        VERCEL_URL: 'conductia-abc.vercel.app',
      }),
    ).toBe('https://app.conductia.com');
    expect(
      resolveConductiaPublicUrl({
        VERCEL_ENV: 'preview',
        VERCEL_PROJECT_PRODUCTION_URL: 'app.conductia.com',
        VERCEL_URL: 'conductia-git-feat.vercel.app',
      }),
    ).toBeNull();
  });

  it('returns null when neither is set', () => {
    expect(resolveConductiaPublicUrl({})).toBeNull();
  });
});

describe('createControlPlane', () => {
  it('POSTs skill_invoked with requestedBy and the shared inbound key', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          executionId: 'ex_1',
          runId: 'run_1',
          agentName: 'md-briefing',
          status: 'queued',
          acceptedAt: '2026-08-18T00:00:00.000Z',
          links: { self: '/v1/runs/ex_1', events: '/e', cancel: '/c', input: '/i' },
        }),
        { status: 202, headers: { 'content-type': 'application/json' } },
      ),
    );

    const plane = createControlPlane(
      {
        baseUrl: 'http://localhost:4111',
        apiKey: 'local-dev-key',
        tenantId: 'tn_demo',
        leadIdOverride: 'lead-001',
        benchUrl: 'http://localhost:4212',
        conductiaBaseUrl: null,
      },
      fetchImpl as unknown as typeof fetch,
    );

    const accepted = await plane.triggerMdBriefing({
      tenantId: 'tn_demo',
      leadId: 'lead-001',
      token: 'jwt',
      requestedBy: { userId: 'u-1', displayName: 'Ada' },
      inputs: { meetingType: 'first_call', depth: 'one_pager' },
      idempotencyKey: 'md-brief:1',
    });

    expect(accepted.executionId).toBe('ex_1');
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://localhost:4111/v1/agents/md-briefing/runs');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('local-dev-key');
    const body = JSON.parse(String(init.body)) as {
      triggerType: string;
      inputs: { meetingType: string };
      requestedBy: { userId: string };
    };
    expect(body.triggerType).toBe('skill_invoked');
    expect(body.inputs.meetingType).toBe('first_call');
    expect(body.requestedBy.userId).toBe('u-1');
    expect(body).not.toHaveProperty('conductiaBaseUrl');
  });

  it('names this Conductia on a trigger when CONDUCTIA_PUBLIC_URL is set', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            executionId: 'ex_1',
            runId: 'run_1',
            agentName: 'md-briefing',
            status: 'queued',
            acceptedAt: '2026-08-18T00:00:00.000Z',
            links: { self: '/v1/runs/ex_1', events: '/e', cancel: '/c', input: '/i' },
          }),
          { status: 202, headers: { 'content-type': 'application/json' } },
        ),
    );
    const plane = createControlPlane(
      {
        baseUrl: 'https://api.conductia-prototype.com',
        apiKey: 'deploy-key',
        tenantId: 'tn_demo',
        leadIdOverride: null,
        benchUrl: 'https://api.conductia-prototype.com',
        conductiaBaseUrl: 'https://app.conductia.com',
      },
      fetchImpl as unknown as typeof fetch,
    );
    await plane.triggerMdBriefing({
      tenantId: 'tn_demo',
      leadId: 'lead-001',
      token: 'jwt',
      requestedBy: { userId: 'u-1', displayName: 'Ada' },
      inputs: { meetingType: 'first_call', depth: 'one_pager' },
      idempotencyKey: 'md-brief:1',
    });
    const body = JSON.parse(
      String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body),
    ) as { conductiaBaseUrl?: string };
    expect(body.conductiaBaseUrl).toBe('https://app.conductia.com');
  });

  it('POSTs document_uploaded with a documentId for source-intelligence', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          executionId: 'ex_si',
          runId: 'run_si',
          agentName: 'source-intelligence',
          status: 'queued',
          acceptedAt: '2026-08-18T00:00:00.000Z',
          links: { self: '/v1/runs/ex_si', events: '/e', cancel: '/c', input: '/i' },
        }),
        { status: 202, headers: { 'content-type': 'application/json' } },
      ),
    );
    const plane = createControlPlane(
      {
        baseUrl: 'http://localhost:4111',
        apiKey: 'local-dev-key',
        tenantId: 'tn_demo',
        leadIdOverride: null,
        benchUrl: 'http://localhost:4212',
        conductiaBaseUrl: null,
      },
      fetchImpl as unknown as typeof fetch,
    );
    await plane.triggerSkill({
      agentName: 'source-intelligence',
      tenantId: 'tn_demo',
      leadId: 'company-1',
      token: 'jwt',
      requestedBy: { userId: 'u-1', displayName: 'Ada' },
      triggerType: 'document_uploaded',
      documentId: 'doc_debrief',
      idempotencyKey: 'si:1',
    });
    const body = JSON.parse(
      String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body),
    ) as {
      triggerType: string;
      documentId: string;
    };
    expect(body.triggerType).toBe('document_uploaded');
    expect(body.documentId).toBe('doc_debrief');
  });

  it('surfaces an Ignatious error envelope', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ error: { code: 'unknown_run', message: 'no such run' } }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      ),
    );
    const plane = createControlPlane(
      {
        baseUrl: 'http://localhost:4111',
        apiKey: 'local-dev-key',
        tenantId: 'tn_demo',
        leadIdOverride: null,
        benchUrl: 'http://localhost:4212',
        conductiaBaseUrl: null,
      },
      fetchImpl as unknown as typeof fetch,
    );

    await expect(plane.getRun('missing')).rejects.toMatchObject({
      name: 'IgnatiousRequestError',
      status: 404,
      body: { code: 'unknown_run', message: 'no such run' },
    } satisfies Partial<IgnatiousRequestError>);
  });

  it('unwraps GET /v1/runs/{id} from { run } and defaults missing arrays', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          run: {
            executionId: 'ex_2',
            runId: 'run_2',
            agentName: 'md-briefing',
            status: 'running',
            outcome: null,
            startedAt: '2026-08-18T00:00:00.000Z',
            finishedAt: null,
            dryRun: false,
            costUsd: null,
            durationMs: null,
            error: null,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const plane = createControlPlane(
      {
        baseUrl: 'http://localhost:4111',
        apiKey: 'local-dev-key',
        tenantId: 'tn_demo',
        leadIdOverride: null,
        benchUrl: 'http://localhost:4212',
        conductiaBaseUrl: null,
      },
      fetchImpl as unknown as typeof fetch,
    );

    const status = await plane.getRun('ex_2');
    expect(status).toMatchObject({
      executionId: 'ex_2',
      status: 'running',
      pendingQuestions: [],
      artifacts: [],
      filings: [],
      modelIds: [],
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://localhost:4111/v1/runs/ex_2',
      expect.any(Object),
    );
  });

  it('reads the models a run called from run.modelIds, dropping anything that is not an id', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          run: {
            executionId: 'ex_3',
            status: 'completed',
            costUsd: 0.31,
            modelIds: ['anthropic/claude-sonnet-5', '', 7, 'anthropic/claude-haiku-5'],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const plane = createControlPlane(
      {
        baseUrl: 'http://localhost:4111',
        apiKey: 'k',
        tenantId: 'tn_demo',
        leadIdOverride: null,
        benchUrl: 'http://localhost:4212',
        conductiaBaseUrl: null,
      },
      fetchImpl as unknown as typeof fetch,
    );
    expect((await plane.getRun('ex_3')).modelIds).toEqual(['anthropic/claude-sonnet-5', 'anthropic/claude-haiku-5']);
  });
});
