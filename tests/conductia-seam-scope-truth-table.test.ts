import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SCOPE, type AgentScope } from '@/lib/conductia/scopes';
import { benchScopes, mintTriggerToken, skillStepRunScopes } from '@/lib/ignatious/jwt';

/**
 * Every `/v1` agent-seam route and the one scope it requires (#196).
 *
 * The table is exhaustive: a route file or HTTP method added under `src/app/v1`
 * without a row here fails the first test, so a new route cannot ship with an
 * undeclared grant. Each row is then proven against the handler itself: under
 * `enforce`, a signed token granted every scope EXCEPT the row's is refused
 * with exactly that scope named. The scope check runs before any storage
 * read, so no database is needed.
 */

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
type Row = { route: string; method: Method; scope: AgentScope };

const TRUTH_TABLE: readonly Row[] = [
  { route: 'leads/[leadId]', method: 'GET', scope: SCOPE.LEAD_READ },
  { route: 'leads/[leadId]/change-tracking', method: 'GET', scope: SCOPE.LEAD_READ },
  { route: 'leads/[leadId]/documents', method: 'GET', scope: SCOPE.DOCUMENTS_READ },
  { route: 'leads/[leadId]/documents', method: 'POST', scope: SCOPE.DOCUMENTS_WRITE },
  { route: 'leads/[leadId]/documents/[documentId]', method: 'GET', scope: SCOPE.DOCUMENTS_READ },
  { route: 'leads/[leadId]/fields', method: 'PATCH', scope: SCOPE.LEAD_WRITE },
  { route: 'leads/[leadId]/notes', method: 'POST', scope: SCOPE.NOTES_WRITE },
  { route: 'leads/[leadId]/relationship-map', method: 'GET', scope: SCOPE.MAPS_READ },
  { route: 'leads/[leadId]/relationship-map', method: 'PATCH', scope: SCOPE.MAPS_WRITE },
  { route: 'leads/[leadId]/stakeholder-map', method: 'GET', scope: SCOPE.MAPS_READ },
  { route: 'leads/[leadId]/stakeholder-map', method: 'PATCH', scope: SCOPE.MAPS_WRITE },
  { route: 'leads/[leadId]/tasks', method: 'GET', scope: SCOPE.LEAD_READ },
  { route: 'leads/[leadId]/tasks', method: 'POST', scope: SCOPE.TASKS_WRITE },
  { route: 'library', method: 'GET', scope: SCOPE.LIBRARY_READ },
  { route: 'personas', method: 'GET', scope: SCOPE.PERSONAS_READ },
  { route: 'personas', method: 'POST', scope: SCOPE.PERSONAS_WRITE },
  { route: 'personas/[personaId]', method: 'GET', scope: SCOPE.PERSONAS_READ },
  { route: 'personas/[personaId]', method: 'PATCH', scope: SCOPE.PERSONAS_WRITE },
  { route: 'personas/[personaId]/links', method: 'POST', scope: SCOPE.PERSONAS_WRITE },
];

const V1_ROOT = path.resolve(__dirname, '../src/app/v1');
const LEAD = 'FALCO-2026-100';
const ALL_SCOPES = Object.values(SCOPE) as AgentScope[];

/** Directories under `src/app/v1` holding a `route.ts`, relative to it. */
function routeDirs(dir = V1_ROOT): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return routeDirs(path.join(dir, entry.name));
    return entry.name === 'route.ts' ? [path.relative(V1_ROOT, dir).split(path.sep).join('/')] : [];
  });
}

function exportedMethods(route: string): Method[] {
  const source = readFileSync(path.join(V1_ROOT, route, 'route.ts'), 'utf8');
  return [
    ...source.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PATCH|PUT|DELETE)\b/g),
  ].map((match) => match[1] as Method);
}

const key = (row: { route: string; method: Method }): string => `${row.method} /v1/${row.route}`;

type Handler = (
  request: Request,
  context: { params: Promise<Record<string, string>> },
) => Promise<Response>;

beforeEach(() => {
  vi.stubEnv('IGNATIOUS_CONTROL_PLANE_URL', 'http://localhost:4111');
  vi.stubEnv('IGNATIOUS_API_KEY', 'local-dev-key');
  vi.stubEnv('IGNATIOUS_TENANT_ID', 'tn_demo');
  vi.stubEnv('CONDUCTIA_TRIGGER_TOKEN_SECRET', 'test-signing-secret');
  vi.stubEnv('CONDUCTIA_TRIGGER_TOKEN_MODE', 'enforce');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('/v1 route-by-scope truth table', () => {
  it('has exactly one row per /v1 route and method', () => {
    const onDisk = routeDirs()
      .flatMap((route) => exportedMethods(route).map((method) => key({ route, method })))
      .sort();
    const rows = TRUTH_TABLE.map(key);
    expect(new Set(rows).size).toBe(rows.length);
    expect([...rows].sort()).toEqual(onDisk);
  });

  it.each(TRUTH_TABLE)('$method /v1/$route requires $scope', async ({ route, method, scope }) => {
    const handlers = (await import(/* @vite-ignore */ `@/app/v1/${route}/route`)) as Record<Method, Handler>;
    const token = mintTriggerToken({
      conductiaTenantId: 'tenant-a',
      agentName: 'truth-table',
      dealId: LEAD,
      scopes: ALL_SCOPES.filter((granted) => granted !== scope),
    });
    const concrete = route
      .replace('[leadId]', LEAD)
      .replace('[documentId]', 'doc-1')
      .replace('[personaId]', 'persona-1');
    const request = new Request(`http://localhost:3000/v1/${concrete}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-conductia-tenant-id': 'tn_demo',
        'x-conductia-lead-id': LEAD,
        'x-conductia-agent-name': 'truth-table',
        'x-conductia-run-id': 'run_1',
      },
      ...(method === 'GET' ? {} : { body: '{}' }),
    });

    const response = await handlers[method](request, {
      params: Promise.resolve({ leadId: LEAD, documentId: 'doc-1', personaId: 'persona-1' }),
    });

    expect(response.status).toBe(403);
    const body = (await response.json()) as {
      error: { code: string; detail: { required?: string } };
    };
    expect(body.error.code).toBe('scope_denied');
    expect(body.error.detail.required).toBe(scope);
  });
});

describe('skill bench grant', () => {
  it('covers every scope a skill step run is granted, documents.write included', () => {
    // Bench chat runs the same tagged skills as the rail's step runner, and
    // those file documents. A read-only bench token is refused under enforce.
    expect(benchScopes()).toEqual(expect.arrayContaining([...skillStepRunScopes()]));
    expect(benchScopes()).toContain(SCOPE.DOCUMENTS_WRITE);
  });
});
