import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/*
 * Deal discovery: a recompute request is cleared only once the assessment it
 * asked for is saved, against a REAL database.
 *
 *   set a step (queues a request) -> an assessment save that fails -> the
 *   request is still there -> the next run assesses it and clears it.
 *
 * What is real: the classification worker, the extract loop, the Supabase
 * store, the step route, the correction RPC, Postgres. What is faked: the
 * model (a test-owned double), the signed-in client (the cookie layer needs
 * Next) and one failing assessment save (a wrapper over the service client).
 */

import { createDiscoveryTenant, type Persona } from './helpers/discoveryTenant';

const harness = createDiscoveryTenant('rq');

vi.mock('@/lib/supabase/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/supabase/server')>();
  return { ...actual, createSupabaseServerClient: async () => harness.activeSession() };
});

import type { SupabaseClient } from '@supabase/supabase-js';

import { GET as listRoute } from '@/app/api/v1/discovery/candidates/route';
import { GET as detailRoute } from '@/app/api/v1/discovery/candidates/[candidateId]/route';
import { POST as rejectRoute } from '@/app/api/v1/discovery/candidates/[candidateId]/reject/route';
import { POST as stationRoute } from '@/app/api/v1/discovery/candidates/[candidateId]/station/route';
import { runExtractOnce } from '@/lib/discovery/extract/run';
import { supabaseExtractStore } from '@/lib/discovery/extract/store';
import type { ModelTransport } from '@/lib/modelGateway/transports';
import { DEMO_REPLY_TABLE } from '../helpers/demoReplyTable';
import { modelReplyDouble } from '../helpers/modelReplyDouble';

const { db, tenantId } = harness;
// The harness tenant is not synthetic, so the gate replays for it only on loopback: pass the local stack's URL alone.
const GATE_ENV = { NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL };
const store = supabaseExtractStore(db);

/** The service client, except that the first assessment save answers with a database error. */
function dbFailingAssessmentOnce(): SupabaseClient {
  let failed = false;
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== 'rpc') return Reflect.get(target, prop, receiver);
      return (name: string, args: unknown) => {
        if (name === 'discovery_record_assessment' && !failed) {
          failed = true;
          return Promise.resolve({ data: null, error: { code: 'XX000', message: 'simulated crash' } });
        }
        return target.rpc(name, args as Record<string, unknown>);
      };
    },
  });
}

async function list(persona: Persona) {
  harness.sessionFor(persona);
  const res = await listRoute();
  expect(res.status).toBe(200);
  return (await res.json()).candidates as Array<{ id: string; name: string }>;
}

async function detail(persona: Persona, id: string) {
  harness.sessionFor(persona);
  const res = await detailRoute(new Request('http://localhost/'), { params: Promise.resolve({ candidateId: id }) });
  return { status: res.status, body: await res.json() };
}

async function post(route: typeof stationRoute, id: string, body: Record<string, unknown>) {
  harness.sessionFor('alice');
  const res = await route(
    new Request(`http://localhost/api/v1/discovery/candidates/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ candidateId: id }) },
  );
  return res.status;
}

async function doubleByUuid(): Promise<ModelTransport & { sent: string[] }> {
  const { data, error } = await db.from('source_items').select('id, internet_message_id').eq('tenant_id', tenantId);
  if (error) throw new Error(`item lookup failed: ${error.message}`);
  const messageIdOf = new Map((data ?? []).map((r) => [r.id as string, r.internet_message_id as string]));
  const inner = modelReplyDouble(DEMO_REPLY_TABLE);
  return {
    kind: 'recorded',
    get sent() {
      return inner.sent;
    },
    send: (req) =>
      inner.send(
        req.purpose === 'milestone_extract'
          ? { ...req, sourceItemId: messageIdOf.get(req.sourceItemId) ?? req.sourceItemId }
          : req,
      ),
  };
}

const extract = async (s = store) => runExtractOnce({ tenantId, transport: await doubleByUuid(), store: s, env: GATE_ENV });

const requestsFor = async (candidateId: string) =>
  (await db.from('discovery_recompute_requests').select('*', { count: 'exact', head: true }).eq('candidate_id', candidateId)).count ?? 0;

let previousFlag: { enabled: boolean } | null = null;

beforeAll(async () => {
  await harness.setup();
  const { data } = await db.from('feature_flags').select('enabled').eq('key', 'company_access_management').maybeSingle();
  previousFlag = data as { enabled: boolean } | null;
  const { error } = await db
    .from('feature_flags')
    .upsert({ key: 'company_access_management', description: 'company access (integration)', enabled: true }, { onConflict: 'key' });
  if (error) throw new Error(`flag upsert failed: ${error.message}`);
});

afterAll(async () => {
  if (previousFlag) await db.from('feature_flags').update({ enabled: previousFlag.enabled }).eq('key', 'company_access_management');
  else await db.from('feature_flags').delete().eq('key', 'company_access_management');
  await harness.cleanup();
});

describe('a recompute request is cleared only after its assessment is saved', () => {
  let kestrel = '';
  let osprey = '';

  it('classifies and extracts the demo corpus', async () => {
    await harness.seedDemo();
    expect(await extract()).toMatchObject({ invalid: 0, failed: 0 });
    kestrel = (await list('alice')).find((c) => c.name === 'Project Kestrel')!.id;
    osprey = (await list('alice')).find((c) => c.name === 'Project Osprey')!.id;
    expect(await requestsFor(kestrel)).toBe(0);
  });

  it('keeps the request when the assessment save fails, and a later run assesses and clears it', async () => {
    expect(await post(stationRoute, kestrel, { stepId: 'p5-s51', reason: 'Signing confirmed by phone' })).toBe(200);
    expect(await requestsFor(kestrel)).toBe(1);

    await expect(extract(supabaseExtractStore(dbFailingAssessmentOnce()))).rejects.toThrow('record assessment failed');
    expect(await requestsFor(kestrel)).toBe(1); // the correction is still owed an assessment

    const summary = await extract();
    expect(summary.assessed).toBeGreaterThanOrEqual(1);
    expect(await requestsFor(kestrel)).toBe(0);
    const c = (await detail('alice', kestrel)).body.candidate;
    expect(c.station.flags).toContain('overridden');
  });

  it('clears the request of a rejected candidate, which is never assessed', async () => {
    expect(await post(rejectRoute, osprey, { reason: 'Not ours' })).toBe(200);
    const { error } = await db
      .from('discovery_recompute_requests')
      .insert({ tenant_id: tenantId, candidate_id: osprey, reason: 'correction' });
    expect(error).toBeNull();
    expect(await requestsFor(osprey)).toBe(1);

    await extract();
    expect(await requestsFor(osprey)).toBe(0);
  });
});
