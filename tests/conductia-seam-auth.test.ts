import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { requireConductiaScope } from '@/lib/conductia/auth';
import { requireConductiaLead } from '@/lib/conductia/route';
import { SCOPE } from '@/lib/conductia/scopes';
import {
  benchScopes,
  digitalTwinScopes,
  mdBriefingScopes,
  mintTriggerToken,
  presearchScopes,
  readTriggerClaims,
  skillRunRevisionScopes,
  sourceIntelligenceScopes,
  verifyTriggerClaims,
} from '@/lib/ignatious/jwt';
import { TRIGGER_TOKEN_MAX_AGE_MS } from '@/lib/ignatious/triggerToken';

import { captureConsole } from './helpers/consoleCapture';

/**
 * The `/v1` agent seam used to accept ANY token it could base64-decode: a
 * non-null decode was the authentication decision, so a caller who could
 * reach the route could mint a token naming any agent, any deal and any
 * acting user. Every case below fails on that code and passes on this one.
 */

const LEAD = 'FALCO-2026-100';
const KEY = 'local-dev-key';
const SECRET = 'test-signing-secret';

function seamEnv(extra: Record<string, string> = {}): void {
  vi.stubEnv('IGNATIOUS_CONTROL_PLANE_URL', 'http://localhost:4111');
  vi.stubEnv('IGNATIOUS_API_KEY', KEY);
  vi.stubEnv('IGNATIOUS_TENANT_ID', 'tn_demo');
  vi.stubEnv('CONDUCTIA_TRIGGER_TOKEN_SECRET', SECRET);
  for (const [k, v] of Object.entries(extra)) vi.stubEnv(k, v);
}

function seamRequest(
  bearer: string,
  headers: Record<string, string> = {},
): Request {
  return new Request(`http://localhost:3000/v1/leads/${LEAD}`, {
    headers: {
      Authorization: `Bearer ${bearer}`,
      'x-conductia-tenant-id': 'tn_demo',
      'x-conductia-lead-id': LEAD,
      'x-conductia-agent-name': 'md-briefing',
      'x-conductia-run-id': 'run_1',
      ...headers,
    },
  });
}

const b64 = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

/** What a forger could build before the seam checked a signature. */
function forgedToken(payload: Record<string, unknown>): string {
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.local-dev`;
}

beforeEach(() => {
  // console noise from the seam's decision log is expected; keep it quiet.
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('agent seam: forged and malformed tokens', () => {
  it('refuses a hand-rolled token that merely decodes', () => {
    seamEnv();
    const forged = forgedToken({ agentName: 'md-briefing', dealId: LEAD });

    // The regression itself: `readTriggerClaims` returning non-null WAS the
    // authentication decision, and it still says yes to this token. The gate
    // no longer asks it.
    expect(readTriggerClaims(`Bearer ${forged}`)).not.toBeNull();
    expect(verifyTriggerClaims(`Bearer ${forged}`)).toBeNull();

    expect(requireConductiaScope(seamRequest(forged), LEAD).ok).toBe(false);
  });

  it('refuses a two-segment token with no signature at all', () => {
    seamEnv();
    const token = `${b64({ alg: 'none' })}.${b64({ agentName: 'x', dealId: LEAD })}`;
    expect(requireConductiaScope(seamRequest(token), LEAD).ok).toBe(false);
  });

  it('refuses a token signed with the wrong key', () => {
    vi.stubEnv('CONDUCTIA_TRIGGER_TOKEN_SECRET', 'someone-elses-secret');
    const token = mintTriggerToken({ conductiaTenantId: 'tenant-a', agentName: 'md-briefing', dealId: LEAD, scopes: [] });
    vi.unstubAllEnvs();
    seamEnv();
    expect(requireConductiaScope(seamRequest(token), LEAD).ok).toBe(false);
  });

  it('refuses a token whose header was rewritten after signing', () => {
    seamEnv();
    const token = mintTriggerToken({ conductiaTenantId: 'tenant-a', agentName: 'md-briefing', dealId: LEAD, scopes: [] });
    const [, payload, signature] = token.split('.');
    // The signature covers `header.payload`, so swapping alg invalidates it.
    const swapped = `${b64({ alg: 'none', typ: 'JWT' })}.${payload}.${signature}`;
    expect(requireConductiaScope(seamRequest(swapped), LEAD).ok).toBe(false);
  });

  it('refuses a token whose payload was edited after signing', () => {
    seamEnv();
    const token = mintTriggerToken({ conductiaTenantId: 'tenant-a', agentName: 'md-briefing', dealId: LEAD, scopes: [] });
    const [header, , signature] = token.split('.');
    const edited = `${header}.${b64({ agentName: 'md-briefing', dealId: 'OTHER-DEAL' })}.${signature}`;
    expect(requireConductiaScope(seamRequest(edited), LEAD).ok).toBe(false);
  });

  it('refuses a signed token that is past the replay window', () => {
    seamEnv();
    const stale = Date.now() - TRIGGER_TOKEN_MAX_AGE_MS - 1_000;
    const token = mintTriggerToken(
      { conductiaTenantId: 'tenant-a', agentName: 'md-briefing', dealId: LEAD, scopes: [] },
      stale,
    );
    expect(requireConductiaScope(seamRequest(token), LEAD).ok).toBe(false);
  });
});

describe('agent seam: credentials that must keep working', () => {
  it('accepts the shared instance key', () => {
    seamEnv();
    const result = requireConductiaScope(seamRequest(KEY), LEAD);
    expect(result).toMatchObject({ ok: true, scope: { credential: 'api_key' } });
  });

  it('accepts a freshly signed trigger token and returns its claims', () => {
    seamEnv();
    const token = mintTriggerToken({
      conductiaTenantId: 'tenant-a',
      agentName: 'md-briefing',
      dealId: LEAD,
      scopes: mdBriefingScopes(),
      userId: 'user-1',
    });
    const result = requireConductiaScope(seamRequest(token), LEAD);
    expect(result).toMatchObject({
      ok: true,
      scope: { credential: 'signed_token', claims: { agentName: 'md-briefing', userId: 'user-1' } },
    });
  });

  it('round-trips the claims of every agent that mints a token', () => {
    seamEnv();
    const agents = [
      { agentName: 'md-briefing', scopes: mdBriefingScopes() },
      { agentName: 'presearch', scopes: presearchScopes() },
      { agentName: 'source-intelligence', scopes: sourceIntelligenceScopes() },
      { agentName: 'digital-twin-builder', scopes: digitalTwinScopes() },
      { agentName: 'digital-twin', scopes: digitalTwinScopes() },
      { agentName: 'skill-bench', scopes: benchScopes() },
      { agentName: 'skill-run-revision', scopes: skillRunRevisionScopes() },
    ];
    for (const agent of agents) {
      const token = mintTriggerToken({ conductiaTenantId: 'tenant-a', ...agent, dealId: LEAD });
      const claims = verifyTriggerClaims(`Bearer ${token}`);
      expect(claims).toMatchObject({ agentName: agent.agentName, dealId: LEAD });
      expect(claims?.scopes).toEqual([...agent.scopes]);
    }
  });
});

describe('agent seam: the tenant id stops leaking', () => {
  it('does not name the expected tenant when the caller guesses wrong', async () => {
    seamEnv();
    const result = requireConductiaScope(
      seamRequest(KEY, { 'x-conductia-tenant-id': 'tn_guess' }),
      LEAD,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const body = await result.response.json();
    expect(result.response.status).toBe(403);
    expect(JSON.stringify(body)).not.toContain('tn_demo');
    expect(body.error.detail).toEqual({});
  });
});

describe('agent seam: scopes are enforced', () => {
  it('refuses a write when the token was granted only reads', () => {
    seamEnv();
    // presearch is a read-only grant.
    const token = mintTriggerToken({
      conductiaTenantId: 'tenant-a',
      agentName: 'presearch',
      dealId: LEAD,
      scopes: presearchScopes(),
    });
    const result = requireConductiaScope(seamRequest(token), LEAD, SCOPE.DOCUMENTS_WRITE);
    expect(result.ok).toBe(false);
  });

  it('allows a write the token was actually granted', () => {
    seamEnv();
    const token = mintTriggerToken({
      conductiaTenantId: 'tenant-a',
      agentName: 'md-briefing',
      dealId: LEAD,
      scopes: mdBriefingScopes(),
    });
    expect(requireConductiaScope(seamRequest(token), LEAD, SCOPE.DOCUMENTS_WRITE).ok).toBe(true);
  });

  it('refuses a document write made with a skill-run-revision token and allows its reads', () => {
    seamEnv();
    const token = mintTriggerToken({
      conductiaTenantId: 'tenant-a',
      agentName: 'skill-run-revision',
      dealId: LEAD,
      scopes: skillRunRevisionScopes(),
    });
    const asBench = { 'x-conductia-agent-name': 'skill-bench' };

    expect(skillRunRevisionScopes()).toEqual([
      'lead.read',
      'documents.read',
      'maps.read',
      'library.read',
      'personas.read',
    ]);
    expect(requireConductiaScope(seamRequest(token, asBench), LEAD, SCOPE.DOCUMENTS_WRITE).ok).toBe(false);
    expect(requireConductiaScope(seamRequest(token, asBench), LEAD, SCOPE.DOCUMENTS_READ).ok).toBe(true);
  });

  it('does not scope-limit the shared instance key', () => {
    seamEnv();
    expect(requireConductiaScope(seamRequest(KEY), LEAD, SCOPE.PERSONAS_WRITE).ok).toBe(true);
  });
});

describe('agent seam: the observe window', () => {
  it('refuses a legacy unsigned token under enforce', () => {
    seamEnv({ CONDUCTIA_TRIGGER_TOKEN_MODE: 'enforce' });
    const legacy = forgedToken({ agentName: 'md-briefing', dealId: LEAD, scopes: [] });
    expect(requireConductiaScope(seamRequest(legacy), LEAD).ok).toBe(false);
  });

  it('defaults to enforce when the mode is unset or misspelled', () => {
    seamEnv({ CONDUCTIA_TRIGGER_TOKEN_MODE: 'observ' });
    const legacy = forgedToken({ agentName: 'md-briefing', dealId: LEAD, scopes: [] });
    expect(requireConductiaScope(seamRequest(legacy), LEAD).ok).toBe(false);
  });

  it('accepts a legacy unsigned token under observe but trusts no claim from it', () => {
    seamEnv({ CONDUCTIA_TRIGGER_TOKEN_MODE: 'observe' });
    const legacy = forgedToken({ agentName: 'md-briefing', dealId: LEAD, userId: 'not-really' });
    const result = requireConductiaScope(seamRequest(legacy), LEAD);
    expect(result).toMatchObject({ ok: true, scope: { credential: 'legacy_unsigned', claims: null } });
  });

  it('records a legacy acceptance so the window can be measured', () => {
    seamEnv({ CONDUCTIA_TRIGGER_TOKEN_MODE: 'observe' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    requireConductiaScope(
      seamRequest(forgedToken({ agentName: 'md-briefing', dealId: LEAD })),
      LEAD,
    );
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('legacy_unsigned'))).toBe(true);
  });
});

describe('agent seam: an unkeyed deployment closes the token path', () => {
  it('refuses every token when no signing key is configured', () => {
    vi.stubEnv('IGNATIOUS_CONTROL_PLANE_URL', 'http://localhost:4111');
    vi.stubEnv('IGNATIOUS_API_KEY', KEY);
    vi.stubEnv('IGNATIOUS_TENANT_ID', 'tn_demo');
    vi.stubEnv('CONDUCTIA_TRIGGER_TOKEN_SECRET', '');
    vi.stubEnv('INVITE_VERIFICATION_PEPPER', '');
    const token = mintTriggerToken({ conductiaTenantId: 'tenant-a', agentName: 'md-briefing', dealId: LEAD, scopes: [] });
    expect(requireConductiaScope(seamRequest(token), LEAD).ok).toBe(false);
    // The shared key still authenticates, so the seam is closed, not broken.
    expect(requireConductiaScope(seamRequest(KEY), LEAD).ok).toBe(true);
  });
});

/**
 * #331 canary: the seam's deny logs used to carry x-conductia-agent-name and
 * x-conductia-run-id verbatim, and both are caller-supplied. They now pass
 * through safeLogId: an identifier-shaped value is logged as is, anything else
 * as `invalid`. The canary has spaces, so it is never identifier-shaped.
 */
describe('agent seam: caller-supplied headers never reach the log', () => {
  const CANARY = 'CANARY-331 mailbox text';
  const canaryHeaders = {
    'x-conductia-agent-name': `${CANARY} agent`,
    'x-conductia-run-id': `${CANARY} run`,
  };

  it('does not log the agent name or run id of an unauthenticated request', () => {
    seamEnv();
    const capture = captureConsole();
    try {
      const result = requireConductiaScope(seamRequest('not-the-key', canaryHeaders), LEAD);
      expect(result.ok).toBe(false);
      // The refusal is still logged, so the check below is not vacuous.
      expect(capture.output()).toContain('authentication');
      expect(capture.output()).not.toContain('CANARY-331');
    } finally {
      capture.restore();
    }
  });

  it('logs an identifier-shaped agent name and run id, so the observe window stays measurable', () => {
    seamEnv();
    const capture = captureConsole();
    try {
      requireConductiaScope(seamRequest('not-the-key'), LEAD);
      expect(capture.output()).toContain('md-briefing');
      expect(capture.output()).toContain('run_1');
    } finally {
      capture.restore();
    }
  });

  it('does not log them when the shared key is refused on a lead route (denyLead)', async () => {
    seamEnv();
    const capture = captureConsole();
    try {
      const result = await requireConductiaLead(seamRequest(KEY, canaryHeaders), LEAD);
      expect(result.ok).toBe(false);
      expect(capture.output()).toContain('api_key');
      expect(capture.output()).not.toContain('CANARY-331');
    } finally {
      capture.restore();
    }
  });

  it('does not log them when the tenant check refuses an authenticated caller', () => {
    seamEnv();
    const capture = captureConsole();
    try {
      const result = requireConductiaScope(
        seamRequest(KEY, { ...canaryHeaders, 'x-conductia-tenant-id': 'tn_guess' }),
        LEAD,
      );
      expect(result.ok).toBe(false);
      expect(capture.output()).toContain('tenant');
      expect(capture.output()).not.toContain('CANARY-331');
    } finally {
      capture.restore();
    }
  });
});
