import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/*
 * Deal discovery, phase 6 (milestones and stage), against a REAL database:
 *
 *   demo corpus -> runOnce (classify) -> runExtractOnce (the model double, the
 *   Supabase store) -> GET /api/v1/discovery/candidates[/{id}] as each user.
 *
 * What is real: the classification worker, the extract loop, the Supabase
 * store and its three definer functions, the route handlers, RLS, Postgres.
 * What is faked: the model (tests/helpers/demoReplyTable.ts, a test-owned
 * double: T2's recording may not exist yet and this test never needs it) and
 * how a handler obtains the signed-in client (the cookie layer needs Next).
 */

import { createDiscoveryTenant, type Persona } from './helpers/discoveryTenant';

const harness = createDiscoveryTenant('dm');

vi.mock('@/lib/supabase/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/supabase/server')>();
  return { ...actual, createSupabaseServerClient: async () => harness.activeSession() };
});

import { GET as listRoute } from '@/app/api/v1/discovery/candidates/route';
import { GET as detailRoute } from '@/app/api/v1/discovery/candidates/[candidateId]/route';
import { runExtractOnce } from '@/lib/discovery/extract/run';
import { supabaseExtractStore } from '@/lib/discovery/extract/store';
import type { ModelTransport } from '@/lib/modelGateway/transports';
import { DEMO_REPLY_TABLE } from '../helpers/demoReplyTable';
import { modelReplyDouble } from '../helpers/modelReplyDouble';

const { db, tenantId } = harness;
// The harness tenant is not synthetic, so the gate replays for it only on loopback: pass the local stack's URL alone.
const GATE_ENV = { NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL };
const store = supabaseExtractStore(db);

type Candidate = { id: string; name: string; station: { station: number | null; title: string } | null };

async function list(persona: Persona): Promise<Candidate[]> {
  harness.sessionFor(persona);
  const res = await listRoute();
  expect(res.status).toBe(200);
  return (await res.json()).candidates as Candidate[];
}

async function detail(persona: Persona, id: string) {
  harness.sessionFor(persona);
  const res = await detailRoute(new Request('http://localhost/'), { params: Promise.resolve({ candidateId: id }) });
  return { status: res.status, body: await res.json() };
}

async function idOf(persona: Persona, name: string): Promise<string> {
  const found = (await list(persona)).find((c) => c.name === name);
  if (!found) throw new Error(`${persona} does not see ${name}`);
  return found.id;
}

/** The model double answers by Message-ID; the store addresses items by uuid, so translate. */
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

beforeAll(async () => {
  await harness.setup();
});

afterAll(async () => {
  await harness.cleanup();
});

describe('demo corpus -> milestones -> step, under RLS', () => {
  it('classifies the demo corpus, then extracts milestones offline and assesses the candidates', async () => {
    const seeded = await harness.seedDemo();
    expect(seeded.candidates.map((c) => c.clusterKey)).toEqual(
      expect.arrayContaining(['codename:kestrel', 'codename:osprey', 'codename:harbor']),
    );

    const transport = await doubleByUuid();
    const summary = await runExtractOnce({ tenantId, transport, store, env: GATE_ENV });
    expect(summary).toMatchObject({ path: 'recorded', invalid: 0, failed: 0, skippedNotSynthetic: 0 });
    expect(summary.selected).toBeGreaterThan(20);
    expect(summary.sent).toBe(summary.selected);
    expect(summary.ok).toBe(summary.sent);
    expect(summary.assessed).toBeGreaterThanOrEqual(3);
  });

  it('shows Storm Kestrel at step 44 with the templated reason and his own excerpt', async () => {
    const kestrel = await idOf('alice', 'Project Kestrel');
    const { status, body } = await detail('alice', kestrel);
    expect(status).toBe(200);
    const c = body.candidate;
    expect(c.station).toMatchObject({
      stepId: 'p4-s48',
      station: 44,
      total: 61,
      title: 'LOI Review',
      lifecycle: 'live',
      reason: 'LOI Review because LOI signed on Sep 18, 2026 (3 emails)',
    });
    // Storm holds all three LOI mails, so every cited item is his own and quotes the signing.
    expect(c.evidence).toHaveLength(3);
    for (const item of c.evidence) {
      expect(item.own).toBe(true);
      const [from, to] = item.excerpt.highlight;
      expect(item.excerpt.text.slice(from, to)).toMatch(/LOI|letter of intent/i);
    }
    expect(c.milestones.length).toBeGreaterThan(8);
    expect(c.milestones.every((m: { own: boolean }) => m.own)).toBe(true);
    expect(c.milestones.map((m: { type: string }) => m.type)).toContain('loi_signed');

    const fromList = (await list('alice')).find((x) => x.id === kestrel);
    expect(fromList?.station).toEqual({ station: 44, title: 'LOI Review' });
  });

  it('shows Storm Osprey at step 53, closed', async () => {
    const { body } = await detail('alice', await idOf('alice', 'Project Osprey'));
    expect(body.candidate.station).toMatchObject({
      stepId: 'p5-s57',
      station: 53,
      lifecycle: 'closed',
      reason: 'Closing Checklist because closing on Jul 15, 2025 (1 email)',
    });
  });

  it('shows the colleague a Storm-only LOI mail as metadata, never its text', async () => {
    const kestrel = await idOf('colleague', 'Project Kestrel');
    const { status, body } = await detail('colleague', kestrel);
    expect(status).toBe(200);
    expect(body.candidate.station).toMatchObject({ station: 44 });
    const own = body.candidate.evidence.filter((e: { own: boolean }) => e.own);
    const others = body.candidate.evidence.filter((e: { own: boolean }) => !e.own);
    expect(own.length).toBeGreaterThan(0);
    expect(others.length).toBeGreaterThan(0);
    for (const item of others) expect(item.excerpt).toBeNull();
    expect(body.candidate.milestones.some((m: { own: boolean }) => !m.own)).toBe(true);
  });

  it('keeps Harbor, which only Storm holds, from the colleague: not listed, and a 404 by id', async () => {
    const harbor = await idOf('alice', 'Project Harbor');
    expect((await list('colleague')).map((c) => c.name)).not.toContain('Project Harbor');
    const { status, body } = await detail('colleague', harbor);
    expect(status).toBe(404);
    expect(body).toEqual({ error: 'Proposed deal not found' });
    expect((await detail('alice', harbor)).body.candidate.station).toMatchObject({ stepId: 'p4-s48' });
  });

  it('shows Bob, who holds no deal mail, nothing, and the firm admin nothing', async () => {
    expect(await list('bob')).toEqual([]);
    expect(await list('admin')).toEqual([]);
    const kestrel = await idOf('alice', 'Project Kestrel');
    expect((await detail('bob', kestrel)).status).toBe(404);
    expect((await detail('admin', kestrel)).status).toBe(404);
  });

  it('shows the control room every step and no text', async () => {
    const kestrel = await idOf('cco', 'Project Kestrel');
    const { body } = await detail('cco', kestrel);
    expect(body.candidate.station).toMatchObject({ station: 44 });
    expect(body.candidate.evidence.every((e: { own: boolean; excerpt: unknown }) => !e.own && e.excerpt === null)).toBe(true);
  });

  it('answers 404 to a non-uuid id', async () => {
    expect((await detail('alice', 'not-a-uuid')).status).toBe(404);
  });

  it('sends nothing on a second run', async () => {
    const transport = await doubleByUuid();
    const summary = await runExtractOnce({ tenantId, transport, store, env: GATE_ENV });
    expect(summary).toMatchObject({ selected: 0, sent: 0, assessed: 0 });
    expect(transport.sent).toEqual([]);
  });

  it('stores ids, counts and offsets, never a quote, and writes no usage row for a replay', async () => {
    const { data: calls } = await db.from('model_calls').select('*').eq('tenant_id', tenantId);
    expect((calls ?? []).length).toBeGreaterThan(20);
    expect(JSON.stringify(calls)).not.toMatch(/letter of intent|countersigned|Kestrel/i);
    expect((calls ?? []).every((c) => c.transport === 'recorded' && c.outcome === 'ok')).toBe(true);

    const { data: events } = await db.from('milestone_events').select('type, span_start, span_end').eq('tenant_id', tenantId);
    expect((events ?? []).length).toBeGreaterThan(20);

    const { count: usage } = await db
      .from('ai_usage')
      .select('*', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .eq('source', 'discovery_extract');
    expect(usage).toBe(0);

    const audited = async (action: string) =>
      (await db.from('audit_log').select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('action', action)).count;
    expect(await audited('discovery.milestone_extracted')).toBe(calls!.length);
    expect(await audited('discovery.stage_assessed')).toBeGreaterThanOrEqual(3);
    const { data: rows } = await db
      .from('audit_log')
      .select('actor_type, actor_id, service_identity, detail')
      .eq('tenant_id', tenantId)
      .eq('action', 'discovery.milestone_extracted')
      .limit(1);
    expect(rows![0]).toMatchObject({ actor_type: 'model', actor_id: null, service_identity: 'model-gateway' });
    expect(JSON.stringify(rows![0].detail)).not.toMatch(/letter|Kestrel/i);
  });

  it('prices a live call from its tokens, once per response id, with no user actor', async () => {
    const usage = { model: 'anthropic/claude-sonnet-5', inputTokens: 1000, outputTokens: 100, externalId: 'msg_it_phase3' };
    await store.recordUsage(tenantId, usage);
    await store.recordUsage(tenantId, usage);
    const { data } = await db.from('ai_usage').select('actor_id, model, cost_usd, source, task').eq('tenant_id', tenantId);
    expect(data).toHaveLength(1);
    expect(data![0]).toMatchObject({ actor_id: null, model: 'claude-sonnet-5', source: 'discovery_extract', task: 'milestone_extract' });
    expect(Number(data![0].cost_usd)).toBe(0.003);
  });

  it('drops a withdrawn mailbox from the next batch and keeps the shared mail', async () => {
    const corpus = JSON.parse(readFileSync('tests/fixtures/discovery/demo/corpus.json', 'utf8')) as {
      messages: Array<{ messageId: string; mailboxes: string[] }>;
    };
    const stormOnly = new Set(
      corpus.messages.filter((m) => m.mailboxes.length === 1 && m.mailboxes[0] === 'storm.duncan@bank.example').map((m) => m.messageId),
    );
    expect(stormOnly.size).toBeGreaterThan(3);

    // Forget every call, so the batch shows exactly what the allowlist still admits.
    await db.from('model_calls').delete().eq('tenant_id', tenantId);
    const before = await store.batch(tenantId, 'v1', 'anthropic/claude-sonnet-5', 200);
    expect(before.some((i) => stormOnly.has(i.internetMessageId))).toBe(true);

    const { error } = await harness.sessionFor('alice').rpc('mailbox_consent_withdraw');
    expect(error).toBeNull();
    const after = await store.batch(tenantId, 'v1', 'anthropic/claude-sonnet-5', 200);
    expect(after.length).toBeGreaterThan(0);
    expect(after.some((i) => stormOnly.has(i.internetMessageId))).toBe(false);
    const ids = new Set(after.map((i) => i.internetMessageId));
    expect(ids.has('<kestrel-001@bank.example>')).toBe(true); // also in Morgan's mailbox
  });
});
