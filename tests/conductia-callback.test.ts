import { afterEach, describe, expect, it } from 'vitest';

import { requireConductiaScope } from '@/lib/conductia/auth';
import { emptyRecord } from '@/lib/conductia/lead';
import { safeFileName } from '@/lib/dataroom/fileToStep';
import { mintTriggerToken } from '@/lib/ignatious/jwt';

describe('requireConductiaScope', () => {
  const prev = { ...process.env };

  afterEach(() => {
    process.env = { ...prev };
  });

  it('rejects a request with no scope headers', () => {
    process.env.IGNATIOUS_CONTROL_PLANE_URL = 'http://localhost:4111';
    process.env.IGNATIOUS_API_KEY = 'local-dev-key';
    process.env.IGNATIOUS_TENANT_ID = 'tn_demo';
    const result = requireConductiaScope(new Request('http://localhost:3000/v1/leads/X'));
    expect(result.ok).toBe(false);
  });

  it('rejects scope headers without a bearer token', () => {
    process.env.IGNATIOUS_CONTROL_PLANE_URL = 'http://localhost:4111';
    process.env.IGNATIOUS_API_KEY = 'local-dev-key';
    process.env.IGNATIOUS_TENANT_ID = 'tn_demo';
    const result = requireConductiaScope(
      new Request('http://localhost:3000/v1/leads/FALCO-2026-100', {
        headers: {
          'x-conductia-tenant-id': 'tn_demo',
          'x-conductia-lead-id': 'FALCO-2026-100',
          'x-conductia-agent-name': 'md-briefing',
          'x-conductia-run-id': 'run_1',
        },
      }),
      'FALCO-2026-100',
    );
    expect(result.ok).toBe(false);
  });

  it('accepts matching tenant and path lead headers', () => {
    process.env.IGNATIOUS_CONTROL_PLANE_URL = 'http://localhost:4111';
    process.env.IGNATIOUS_API_KEY = 'local-dev-key';
    process.env.IGNATIOUS_TENANT_ID = 'tn_demo';
    const result = requireConductiaScope(
      new Request('http://localhost:3000/v1/leads/FALCO-2026-100', {
        headers: {
          Authorization: 'Bearer local-dev-key',
          'x-conductia-tenant-id': 'tn_demo',
          'x-conductia-lead-id': 'FALCO-2026-100',
          'x-conductia-agent-name': 'md-briefing',
          'x-conductia-run-id': 'run_1',
        },
      }),
      'FALCO-2026-100',
    );
    expect(result).toMatchObject({
      ok: true,
      scope: { tenantId: 'tn_demo', leadId: 'FALCO-2026-100', agentName: 'md-briefing' },
    });
  });

  it('accepts the SIGNED trigger JWT skill-bench forwards on Conductia calls', () => {
    process.env.IGNATIOUS_CONTROL_PLANE_URL = 'http://localhost:4111';
    process.env.IGNATIOUS_API_KEY = 'local-dev-key';
    process.env.IGNATIOUS_TENANT_ID = 'tn_demo';
    process.env.CONDUCTIA_TRIGGER_TOKEN_SECRET = 'test-signing-secret';
    const token = mintTriggerToken({
      conductiaTenantId: 'tenant-a',
      agentName: 'skill-bench',
      dealId: 'deal-1',
      scopes: ['maps.read'],
    });
    const result = requireConductiaScope(
      new Request('http://localhost:3000/v1/leads/FALCO-2026-100', {
        headers: {
          Authorization: `Bearer ${token}`,
          'x-conductia-tenant-id': 'tn_demo',
          'x-conductia-lead-id': 'FALCO-2026-100',
          'x-conductia-agent-name': 'skill-bench',
          'x-conductia-run-id': 'run_1',
        },
      }),
      'FALCO-2026-100',
    );
    expect(result).toMatchObject({
      ok: true,
      scope: { tenantId: 'tn_demo', leadId: 'FALCO-2026-100', agentName: 'skill-bench' },
    });
  });
});

describe('emptyRecord', () => {
  it('is the blank intelligence record md-briefing can fill from research', () => {
    expect(emptyRecord()).toEqual({
      clientGoals: {
        whySelling: null,
        priceExpectation: null,
        timingExpectation: null,
        mustHaves: null,
      },
      decisionCriteria: [],
      competingBanks: [],
      winProbability: null,
      preliminaryPitchAngle: { whyUs: null, clientStory: null },
    });
  });
});

describe('safeFileName', () => {
  it('strips path segments so a brief cannot escape the step folder', () => {
    expect(safeFileName('../../secret.docx')).toBe('..-..-secret.docx');
    expect(safeFileName('   ')).toBe('brief.docx');
  });
});
