import { createHash, timingSafeEqual } from 'node:crypto';

import { safeLogId } from '@/lib/errors/logSafe';
import { readIgnatiousConfig } from '@/lib/ignatious/config';
import { readTriggerClaims, verifyTriggerClaims, type TriggerClaims } from '@/lib/ignatious/jwt';
import { triggerTokenMode } from '@/lib/ignatious/triggerToken';

import { conductiaError } from './errors';
import { grantsScope, type AgentScope } from './scopes';

export const SCOPE_HEADERS = {
  tenantId: 'x-conductia-tenant-id',
  leadId: 'x-conductia-lead-id',
  agentName: 'x-conductia-agent-name',
  runId: 'x-conductia-run-id',
} as const;

/**
 * Which credential authenticated the caller.
 *
 * `api_key` is the deployment's own shared key and carries full authority.
 * `signed_token` is a trigger token this deployment minted and verified, and
 * is held to the grant it was minted with. `legacy_unsigned` is a token that
 * decoded but could not be verified: accepted only under `observe`, trusted
 * for nothing.
 */
export type ConductiaCredential = 'api_key' | 'signed_token' | 'legacy_unsigned';

export type ConductiaScope = {
  tenantId: string;
  leadId: string;
  agentName: string;
  runId: string;
  credential: ConductiaCredential;
  /** Verified claims. Null unless `credential` is `signed_token`. */
  claims: TriggerClaims | null;
};

/** The event fields a caller chooses (their headers, or the path they asked for). */
const CALLER_SUPPLIED_FIELDS = ['agentName', 'runId', 'lead'] as const;

/**
 * One structured line per seam decision, so the observe window can prove what
 * the agents backend actually presents before the legacy path is closed.
 *
 * The agent name, run id and lead are caller-supplied headers and a path
 * segment, so they are sanitised here as well as at each call site: an
 * identifier-shaped value is logged as is, anything else as `invalid`
 * (#331, review C3).
 */
function logSeamAuth(outcome: 'accept' | 'deny', event: Record<string, unknown>): void {
  const safe: Record<string, unknown> = { ...event };
  for (const field of CALLER_SUPPLIED_FIELDS) {
    if (typeof safe[field] === 'string') safe[field] = safeLogId(safe[field] as string);
  }
  const line = `[conductia-seam] ${JSON.stringify({ outcome, ...safe })}`;
  if (outcome === 'deny' || event.credential === 'legacy_unsigned') {
    console.warn(line);
    return;
  }
  console.log(line);
}

function verifyConductiaApiKey(request: Request, expectedKey: string): boolean {
  const header = request.headers.get('authorization')?.trim() ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  const provided = match[1].trim();
  if (!provided) return false;
  // Hash first so the compare is always over two 32-byte digests. Comparing
  // the raw values needs a length guard, and that guard is itself an oracle
  // for the key's length. Same shape as the inbound webhook's secret check.
  const given = createHash('sha256').update(provided, 'utf8').digest();
  const want = createHash('sha256').update(expectedKey, 'utf8').digest();
  return timingSafeEqual(given, want);
}

type Credential =
  | { ok: true; credential: ConductiaCredential; claims: TriggerClaims | null }
  | { ok: false };

/**
 * The shared instance key, a trigger token whose signature we verify, or
 * under `observe` a token we could not verify.
 */
function authenticate(request: Request, expectedKey: string): Credential {
  if (verifyConductiaApiKey(request, expectedKey)) {
    return { ok: true, credential: 'api_key', claims: null };
  }

  const authorization = request.headers.get('authorization');
  const verified = verifyTriggerClaims(authorization);
  if (verified) return { ok: true, credential: 'signed_token', claims: verified };

  // Every token landed here before the seam could verify a signature, and a
  // non-null decode WAS the authentication decision. `observe` keeps that
  // behaviour just long enough to prove what production actually sends; the
  // claims are deliberately dropped, so nothing downstream trusts them.
  if (triggerTokenMode() === 'observe' && readTriggerClaims(authorization)) {
    return { ok: true, credential: 'legacy_unsigned', claims: null };
  }

  return { ok: false };
}

export function requireConductiaScope(
  request: Request,
  pathLeadId?: string,
  required?: AgentScope,
): { ok: true; scope: ConductiaScope } | { ok: false; response: Response } {
  const config = readIgnatiousConfig();
  if (!config) {
    return {
      ok: false,
      response: conductiaError(
        'server_error',
        'Ignatious is not configured on this Conductia instance.',
        503,
      ),
    };
  }

  const agentName = request.headers.get(SCOPE_HEADERS.agentName)?.trim() ?? '';
  const runId = request.headers.get(SCOPE_HEADERS.runId)?.trim() ?? '';

  const credential = authenticate(request, config.apiKey);
  if (!credential.ok) {
    logSeamAuth('deny', {
      reason: 'authentication',
      agentName: safeLogId(agentName),
      runId: safeLogId(runId),
      lead: pathLeadId ? safeLogId(pathLeadId) : null,
    });
    return {
      ok: false,
      response: conductiaError(
        'authentication',
        'Missing or invalid Authorization bearer token for the Conductia agent seam.',
        401,
      ),
    };
  }

  const tenantId = request.headers.get(SCOPE_HEADERS.tenantId)?.trim() ?? '';
  const leadId = request.headers.get(SCOPE_HEADERS.leadId)?.trim() ?? '';

  if (!tenantId || !leadId || !agentName || !runId) {
    return {
      ok: false,
      response: conductiaError(
        'authentication',
        'Missing x-conductia-tenant-id, x-conductia-lead-id, x-conductia-agent-name or x-conductia-run-id.',
        401,
      ),
    };
  }

  if (tenantId !== config.tenantId) {
    // The expected tenant is deliberately NOT echoed. It used to be, which
    // handed an unauthenticated caller the one identifier the gate asked for.
    logSeamAuth('deny', {
      reason: 'tenant',
      credential: credential.credential,
      agentName: safeLogId(agentName),
      runId: safeLogId(runId),
    });
    return {
      ok: false,
      response: conductiaError('scope_denied', 'Tenant is not this Conductia instance.', 403),
    };
  }

  if (pathLeadId && pathLeadId !== leadId) {
    return {
      ok: false,
      response: conductiaError(
        'scope_denied',
        'Lead id in the path does not match x-conductia-lead-id.',
        403,
        // Same reasoning as the tenant refusal above. Both values here are
        // caller-supplied, so echoing them leaks nothing today — but the
        // signed-token check below compares the path against a VERIFIED claim,
        // and echoing there would hand back the lead the token is really for.
        // Keeping every refusal on this seam `field`-only removes the chance
        // of one of them quietly becoming an oracle later.
        { field: 'leadId' },
      ),
    };
  }

  // A verified token is held to the grant it was minted with. The shared key
  // is the instance's own credential, not one agent's grant, so it passes.
  if (required && credential.credential === 'signed_token' && credential.claims) {
    if (!grantsScope(credential.claims.scopes, required)) {
      if (triggerTokenMode() === 'enforce') {
        logSeamAuth('deny', {
          reason: 'scope',
          required,
          granted: credential.claims.scopes,
          agentName: safeLogId(agentName),
          runId: safeLogId(runId),
        });
        return {
          ok: false,
          response: conductiaError(
            'scope_denied',
            `This token is not granted ${required}.`,
            403,
            { field: 'scope', required },
          ),
        };
      }
      logSeamAuth('accept', {
        reason: 'scope_would_deny',
        credential: credential.credential,
        required,
        granted: credential.claims.scopes,
        agentName: safeLogId(agentName),
        runId: safeLogId(runId),
      });
    }
  }

  logSeamAuth('accept', {
    credential: credential.credential,
    agentName: safeLogId(agentName),
    runId: safeLogId(runId),
    lead: safeLogId(leadId),
    ...(required ? { scope: required } : {}),
  });

  return {
    ok: true,
    scope: {
      tenantId,
      leadId,
      agentName,
      runId,
      credential: credential.credential,
      claims: credential.claims,
    },
  };
}
