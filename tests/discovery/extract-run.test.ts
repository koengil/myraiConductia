import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { DEV_TENANT_ID } from '@/lib/db/tenant';
import {
  ceilingCostFor,
  ceilingPrices,
  CEILING_BYTES_PER_TOKEN,
  describeSizes,
  estimateExtraction,
  OVERHEAD_BYTES_PER_ITEM,
} from '@/lib/discovery/extract/estimate';
import { runExtractOnce, TeamInboxRefusedError } from '@/lib/discovery/extract/run';
import { parseMilestoneReply } from '@/lib/discovery/extract/parse';
import { supabaseExtractStore } from '@/lib/discovery/extract/store';
import { assessStage } from '@/lib/discovery/stageEngine';
import { MVP_DEAL_RAIL } from '@/lib/rail/dealRail';
import { SYNTHETIC_MESSAGE_IDS } from '@/lib/modelGateway/syntheticCorpus.generated';
import { DEFAULT_EXTRACT_MODEL, GATEWAY_PROCESSOR, ProcessorRefusedError } from '@/lib/modelGateway/processorGate';
import type { ModelRequest, ModelTransport } from '@/lib/modelGateway';
import { ZDR_REFUSED_MESSAGE, ZDR_RETRY_DELAYS_MS, __resetWarnOnceForTests } from '@/lib/modelGateway/gatewayClient';
import { gatewayTransport } from '@/lib/modelGateway/transports';

import { fakePagedSupabase } from '../helpers/fakePagedSupabase';
import { memoryExtractStore } from '../helpers/memoryExtractStore';
import { DEMO_REPLY_TABLE as TABLE } from '../helpers/demoReplyTable';
import { modelReplyDouble, type DoubleTable } from '../helpers/modelReplyDouble';
import ceilingCases from '../fixtures/discovery/extract/ceiling-cases.json';
import { DEMO_GRAPH_DIR, DEMO_LATE_DIR, demoItems } from './demoCorpus';

const SYNTHETIC_ENV: Record<string, string | undefined> = {
  DISCOVERY_EXTRACT_TRANSPORT: 'gateway',
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:55521',
  NEXT_PUBLIC_APP_ENV: 'local',
};
const PILOT = '11111111-2222-4333-8444-555555555555'; // fake: no real tenant id in any fixture
const HOSTED_PROD: Record<string, string | undefined> = {
  DISCOVERY_EXTRACT_TRANSPORT: 'gateway',
  NEXT_PUBLIC_SUPABASE_URL: 'https://abc.supabase.co',
  NEXT_PUBLIC_APP_ENV: 'prod',
};
const OPEN = { verifiedProcessors: [GATEWAY_PROCESSOR], outputPlacementApproved: true, verifiedTenantIds: [PILOT] };
/** What a live Sonnet reply reports: 500 in and 40 out, priced from the table at $0.0014. */
const SONNET_USAGE = { model: 'anthropic/claude-sonnet-5', inputTokens: 500, outputTokens: 40 };
const assessmentOf = (m: ReturnType<typeof memoryExtractStore>, key: string) => m.assessments.get(`codename:${key}`)!;

describe('the double is honest', () => {
  it('quotes only sentences that are in the body it answers', () => {
    const bodies = new Map(demoItems(DEMO_LATE_DIR).map((i) => [i.item.internetMessageId, i.item.bodyText]));
    for (const [id, milestones] of Object.entries(TABLE)) {
      const body = bodies.get(id);
      expect(body, id).toBeDefined();
      const parsed = parseMilestoneReply(JSON.stringify({ milestones: milestones.map((m) => ({ confidence: 0.9, ...m })) }), body!);
      expect(parsed, id).toMatchObject({ ok: true });
    }
  });

  it('names only committed corpus mail', () => {
    for (const id of Object.keys(TABLE)) expect(SYNTHETIC_MESSAGE_IDS.has(id), id).toBe(true);
  });
});

describe('runExtractOnce over the demo corpus, offline', () => {
  it('takes Kestrel to step 44, Osprey to 53 closed, and Harbor to LOI Review', async () => {
    const m = memoryExtractStore(DEMO_GRAPH_DIR);
    const summary = await runExtractOnce({
      tenantId: DEV_TENANT_ID,
      transport: modelReplyDouble(TABLE),
      store: m.store,
      env: {},
    });
    expect(summary).toMatchObject({ path: 'recorded', invalid: 0, failed: 0, skippedNotSynthetic: 0 });
    expect(summary.sent).toBe(summary.selected);

    const kestrel = assessmentOf(m, 'kestrel');
    expect(kestrel).toMatchObject({ stepId: 'p4-s48', station: 44, lifecycle: 'live', flags: [] });
    expect(kestrel.reason).toBe('LOI Review because LOI signed on Sep 18, 2026 (3 emails)');
    expect(kestrel.evidenceEventIds).toHaveLength(3);

    const osprey = assessmentOf(m, 'osprey');
    expect(osprey).toMatchObject({ stepId: 'p5-s57', station: 53, lifecycle: 'closed' });
    expect(osprey.reason).toBe('Closing Checklist because closing on Jul 15, 2025 (1 email)');

    expect(assessmentOf(m, 'harbor')).toMatchObject({ stepId: 'p4-s48', station: 44 });
  });

  it('assesses only candidates that had mail, and Falcon and Cobra read as no milestones', async () => {
    const m = memoryExtractStore(DEMO_GRAPH_DIR);
    await runExtractOnce({ tenantId: DEV_TENANT_ID, transport: modelReplyDouble(TABLE), store: m.store, env: {} });
    expect(assessmentOf(m, 'falcon')).toMatchObject({ stepId: null, station: null });
    expect(assessmentOf(m, 'cobra')).toMatchObject({ stepId: null, station: null });
  });

  it('sends nothing on a second run', async () => {
    const m = memoryExtractStore(DEMO_GRAPH_DIR);
    const first = modelReplyDouble(TABLE);
    await runExtractOnce({ tenantId: DEV_TENANT_ID, transport: first, store: m.store, env: {} });
    const second = modelReplyDouble(TABLE);
    const summary = await runExtractOnce({ tenantId: DEV_TENANT_ID, transport: second, store: m.store, env: {} });
    expect(summary).toMatchObject({ selected: 0, sent: 0, assessed: 0 });
    expect(second.sent).toEqual([]);
  });

  it('retries an item that failed once and then settles it', async () => {
    const m = memoryExtractStore(DEMO_GRAPH_DIR);
    const flaky = new Set(['<kestrel-013@bank.example>']);
    const transport = modelReplyDouble(TABLE, { failFirstFor: flaky });
    const first = await runExtractOnce({ tenantId: DEV_TENANT_ID, transport, store: m.store, env: {} });
    expect(first.failed).toBe(1);
    // Two of the three LOI mails answered, so Kestrel is at 44 on two emails.
    expect(assessmentOf(m, 'kestrel').reason).toContain('(2 emails)');

    const second = await runExtractOnce({ tenantId: DEV_TENANT_ID, transport, store: m.store, env: {} });
    expect(second).toMatchObject({ selected: 1, sent: 1, ok: 1, failed: 0, assessed: 1 });
    expect(assessmentOf(m, 'kestrel').reason).toContain('(3 emails)');
    expect(m.calls.filter((c) => c.sourceItemId === '<kestrel-013@bank.example>').map((c) => [c.attempt, c.outcome])).toEqual([
      [1, 'failed'],
      [2, 'ok'],
    ]);

    const third = await runExtractOnce({ tenantId: DEV_TENANT_ID, transport, store: m.store, env: {} });
    expect(third.selected).toBe(0);
  });

  it('gives up on an item after three failed attempts', async () => {
    const m = memoryExtractStore(DEMO_GRAPH_DIR);
    const always = { kind: 'recorded' as const, async send() { return { ok: false as const, outcome: 'failed' as const, code: 'recording_miss' as const, transport: 'recorded' as const, latencyMs: 0 }; } };
    for (let i = 0; i < 3; i++) await runExtractOnce({ tenantId: DEV_TENANT_ID, transport: always, store: m.store, env: {} });
    const fourth = await runExtractOnce({ tenantId: DEV_TENANT_ID, transport: always, store: m.store, env: {} });
    expect(fourth.selected).toBe(0);
  });

  it('settles an unparseable reply as invalid and never retries it', async () => {
    const m = memoryExtractStore(DEMO_GRAPH_DIR);
    const wrongQuote: DoubleTable = {
      '<kestrel-013@bank.example>': [{ type: 'loi_signed', occurred_on: '2026-09-18', quote: 'A sentence the email never contained.' }],
    };
    const first = await runExtractOnce({ tenantId: DEV_TENANT_ID, transport: modelReplyDouble(wrongQuote), store: m.store, env: {} });
    expect(first.invalid).toBe(1);
    expect(m.calls.find((c) => c.outcome === 'invalid')?.errorCode).toBe('span_not_found');
    const again = await runExtractOnce({ tenantId: DEV_TENANT_ID, transport: modelReplyDouble(wrongQuote), store: m.store, env: {} });
    expect(again.selected).toBe(0);
  });

  it('moves Kestrel to Signing / Announcement Prep when the late mail arrives', async () => {
    const m = memoryExtractStore(DEMO_LATE_DIR);
    await runExtractOnce({ tenantId: DEV_TENANT_ID, transport: modelReplyDouble(TABLE), store: m.store, env: {} });
    const kestrel = assessmentOf(m, 'kestrel');
    expect(kestrel).toMatchObject({ stepId: 'p5-s51', station: 47 });
    expect(kestrel.reason).toBe('Signing / Announcement Prep because signing on Oct 28, 2026 (1 email)');
  });

  it('records no usage for a recorded transport', async () => {
    const m = memoryExtractStore(DEMO_GRAPH_DIR);
    await runExtractOnce({
      tenantId: DEV_TENANT_ID,
      transport: modelReplyDouble(TABLE, { usage: { model: 'anthropic/claude-sonnet-5', inputTokens: 100, outputTokens: 10 } }),
      store: m.store,
      env: {},
    });
    expect(m.usage).toEqual([]);
  });

  it('records the call rows without any quote or body text', async () => {
    const m = memoryExtractStore(DEMO_GRAPH_DIR);
    await runExtractOnce({ tenantId: DEV_TENANT_ID, transport: modelReplyDouble(TABLE), store: m.store, env: {} });
    expect(m.calls.length).toBeGreaterThan(0);
    expect(JSON.stringify(m.calls)).not.toMatch(/letter of intent|Kestrel/);
    expect(m.calls.every((c) => c.transport === 'recorded' && c.promptVersion === 'v1' && c.promptHash.length === 64)).toBe(true);
  });
});

describe('recompute requests', () => {
  const run = (m: ReturnType<typeof memoryExtractStore>) =>
    runExtractOnce({ tenantId: DEV_TENANT_ID, transport: modelReplyDouble(TABLE), store: m.store, env: {} });

  it('clears a request once its assessment is saved', async () => {
    const m = memoryExtractStore(DEMO_GRAPH_DIR);
    await run(m);
    m.ask('codename:kestrel');
    await run(m);
    expect(m.outbox).toEqual([]);
  });

  it('keeps the request when the assessment save fails, and a later run assesses it again', async () => {
    const m = memoryExtractStore(DEMO_GRAPH_DIR);
    await run(m);
    m.ask('codename:kestrel');
    m.control.failAssessmentOnce = true;
    await expect(run(m)).rejects.toThrow('record assessment failed');
    expect(m.outbox).toHaveLength(1);

    const attempts = m.control.saveAttempts;
    await run(m);
    expect(m.control.saveAttempts).toBeGreaterThan(attempts);
    expect(m.outbox).toEqual([]);
  });
});

describe('recompute requests through the Supabase store (#173 G-07 slice 1c)', () => {
  // A fake client: each table answers its fixed rows, and every RPC is recorded. The purge (20261023130300) asks
  // with reason 'purge' after it deletes a stream's latest assessment; that request recomputes under trigger 'purge'.
  function fakeDb(tables: Record<string, unknown[]>) {
    const fake = fakePagedSupabase(tables, (name) => ({ data: name === 'discovery_record_assessment' ? true : [], error: null }));
    return { db: fake.db, rpcs: fake.rpcs };
  }
  const candidate = (id: string) => ({ id, discovery_state: 'proposed', station_override_step_id: null });

  it("recomputes a 'purge' request with trigger 'purge', a correction as a correction, anything else as a re-run", async () => {
    const { db, rpcs } = fakeDb({
      discovery_recompute_requests: [
        { id: 'r-1', candidate_id: 'c-purged', reason: 'purge' },
        { id: 'r-2', candidate_id: 'c-corrected', reason: 'correction' },
        { id: 'r-3', candidate_id: 'c-other', reason: 'something_else' },
      ],
      deal_candidates: [candidate('c-purged'), candidate('c-corrected'), candidate('c-other')],
    });
    const store = supabaseExtractStore(db);
    const work = await store.candidatesToAssess(DEV_TENANT_ID, []);
    expect(Object.fromEntries(work.map((w) => [w.candidateId, w.trigger]))).toEqual({
      'c-purged': 'purge',
      'c-corrected': 'correction',
      'c-other': 'rerun',
    });
    expect(work.find((w) => w.candidateId === 'c-purged')?.requestIds).toEqual(['r-1']);

    const purged = work.find((w) => w.candidateId === 'c-purged')!;
    expect(await store.saveAssessment(DEV_TENANT_ID, purged.candidateId, assessStage(purged.events, MVP_DEAL_RAIL), purged.trigger)).toBe(true);
    const saved = rpcs.find((r) => r.name === 'discovery_record_assessment');
    expect(saved?.args).toMatchObject({ p_candidate_id: 'c-purged', p_trigger: 'purge' });
    expect(saved?.args.p_assessment).toMatchObject({ stepId: null, evidenceEventIds: [] });
  });
});

describe('one rule for an item\'s current events (#173 G-07 slice 2a)', () => {
  it('counts nothing from an item whose latest ok model call found no milestone, though its earlier events stay stored', async () => {
    const m = memoryExtractStore(DEMO_GRAPH_DIR);
    const run = () => runExtractOnce({ tenantId: DEV_TENANT_ID, transport: modelReplyDouble(TABLE), store: m.store, env: {} });
    await run();
    const item = '<kestrel-013@bank.example>';
    const fromItem = () => assessmentOf(m, 'kestrel').evidenceEventIds.filter((id) => id.startsWith(`${item}:`));
    expect(fromItem()).toHaveLength(1);
    expect(assessmentOf(m, 'kestrel').reason).toContain('(3 emails)');

    // The same content answered again under another model, with no milestone: that answer is now current.
    const first = m.calls.find((c) => c.sourceItemId === item && c.outcome === 'ok')!;
    await m.store.saveCall(DEV_TENANT_ID, { ...first, model: 'anthropic/claude-other' }, []);
    m.ask('codename:kestrel');
    await run();
    expect(fromItem()).toEqual([]);
    expect(assessmentOf(m, 'kestrel')).toMatchObject({ stepId: 'p4-s48', station: 44 });
    expect(assessmentOf(m, 'kestrel').reason).toContain('(2 emails)');
  });

  it('keeps every shared event the inputs definer names: the store holds no version rule of its own', async () => {
    const input = (eventId: string, over: Record<string, unknown> = {}) => ({
      candidate_id: 'c-1', source_item_id: 'i-1', event_id: eventId, type: 'loi_signed', occurred_at: '2026-09-18',
      confidence: 0.9, extractor_version: 'v1:m', created_at: '2026-09-30T10:00:00Z', team_mailbox_id: null, basis: 'model', ...over,
    });
    const tables: Record<string, unknown[]> = {
      discovery_recompute_requests: [{ id: 'r-1', candidate_id: 'c-1', reason: 'correction' }],
      deal_candidates: [{ id: 'c-1', discovery_state: 'proposed', station_override_step_id: null }],
    };
    // Two versions of one item (the definer decided both are current), and an event for a team inbox's audience.
    const rows = [
      input('e-older', { extractor_version: 'v0:m-old', created_at: '2026-09-01T10:00:00Z' }),
      input('e-newer', { type: 'signed', occurred_at: '2026-09-20' }),
      input('e-team', { team_mailbox_id: 'tm-1' }),
    ];
    const { db } = fakePagedSupabase(tables, (name) => ({ data: name === 'discovery_audience_assessment_inputs' ? rows : [], error: null }));
    const store = supabaseExtractStore(db);
    const [work] = await store.candidatesToAssess(DEV_TENANT_ID, []);
    expect(work.events.map((e) => e.id)).toEqual(['e-older', 'e-newer']);
  });
});

describe('one assessment per audience (#173 G-07 slice 2b)', () => {
  const T = 'tm-deals';
  const K15 = '<kestrel-015@bank.example>';
  const KESTREL_T = `codename:kestrel|${T}`;
  const run = (m: ReturnType<typeof memoryExtractStore>) =>
    runExtractOnce({ tenantId: DEV_TENANT_ID, transport: modelReplyDouble(TABLE), store: m.store, env: {} });
  const fromK15 = (ids: string[]) => ids.filter((id) => id.startsWith(`${K15}:`));

  it('a team-only event feeds a row scoped to its inbox, never the shared row; once it is gone a tombstone ends the stream', async () => {
    const m = memoryExtractStore(DEMO_GRAPH_DIR);
    // kestrel-015 reached the firm only through deals@ (a stand-in for the rule event slice 3b detects there).
    m.teamItem(K15, T);
    const first = await run(m);
    const shared = assessmentOf(m, 'kestrel');
    expect(shared).toMatchObject({ stepId: 'p4-s48', station: 44, lifecycle: 'live' });
    expect(shared.reason).toBe('LOI Review because LOI signed on Sep 18, 2026 (2 emails)');
    expect(fromK15(shared.evidenceEventIds)).toEqual([]);
    const [scoped] = m.scoped.get(KESTREL_T)!;
    expect(scoped).toMatchObject({ stepId: 'p4-s48', station: 44, trigger: 'extraction', basis: 'model' });
    expect(scoped.reason).toBe('LOI Review because LOI signed on Sep 18, 2026 (3 emails)');
    expect(fromK15(scoped.evidenceEventIds)).toHaveLength(1);
    expect([...m.scoped.keys()]).toEqual([KESTREL_T]); // no other candidate has mail in the inbox
    expect(first.assessedTeam).toBe(1);

    // The same content answered again with no milestone: the inbox adds nothing now.
    const call = m.calls.find((c) => c.sourceItemId === K15 && c.outcome === 'ok')!;
    await m.store.saveCall(DEV_TENANT_ID, { ...call, model: 'anthropic/claude-other' }, []);
    m.ask('codename:kestrel');
    expect(await run(m)).toMatchObject({ assessed: 0, assessedTeam: 1 });
    expect(assessmentOf(m, 'kestrel')).toEqual(shared);
    expect(m.scoped.get(KESTREL_T)!.at(-1)).toMatchObject({
      stepId: null,
      station: null,
      lifecycle: null,
      reason: 'No milestones extracted yet',
      evidenceEventIds: [],
      trigger: 'correction',
      basis: undefined,
    });

    // An ended stream is left alone.
    m.ask('codename:kestrel');
    expect(await run(m)).toMatchObject({ assessedTeam: 0 });
    expect(m.scoped.get(KESTREL_T)).toHaveLength(2);
  });

  it('writes no scoped row for an inbox that adds nothing the shared audience lacks', async () => {
    const m = memoryExtractStore(DEMO_GRAPH_DIR);
    m.teamItem(K15, T, true); // also in a personal mailbox: the shared audience has it
    expect(await run(m)).toMatchObject({ assessedTeam: 0 });
    expect(m.scoped.size).toBe(0);
    expect(assessmentOf(m, 'kestrel').reason).toContain('(3 emails)');
  });

  it('skips the row of an inbox the writer refuses, and still answers the request and the other rows', async () => {
    const m = memoryExtractStore(DEMO_GRAPH_DIR);
    m.teamItem(K15, T);
    await run(m);
    m.refuseInbox(T);
    m.ask('codename:kestrel');
    expect(await run(m)).toMatchObject({ teamRefused: 1, assessedTeam: 0 });
    expect(m.outbox).toEqual([]);
    expect(m.scoped.get(KESTREL_T)).toHaveLength(1);
    expect(assessmentOf(m, 'kestrel').reason).toContain('(2 emails)');
  });

  it('the Supabase store reads each audience and each live stream, and maps a refused inbox to its own error', async () => {
    const input = (eventId: string, team: string | null, basis = 'model') => ({
      candidate_id: 'c-1', source_item_id: `i-${eventId}`, event_id: eventId, type: 'loi_signed', occurred_at: '2026-09-18',
      confidence: 0.9, extractor_version: 'v1:m', created_at: '2026-09-30T10:00:00Z', team_mailbox_id: team, basis,
    });
    const tables: Record<string, unknown[]> = {
      discovery_recompute_requests: [{ id: 'r-1', candidate_id: 'c-1', reason: 'correction' }],
      deal_candidates: [{ id: 'c-1', discovery_state: 'proposed', station_override_step_id: null }],
      stage_assessments: [
        { candidate_id: 'c-1', team_mailbox_id: 'tm-1', step_id: 'p4-s48', as_of: '2026-09-30T10:00:00Z', id: 'a-1' },
        { candidate_id: 'c-1', team_mailbox_id: 'tm-2', step_id: 'p2-s28', as_of: '2026-09-29T10:00:00Z', id: 'a-2' },
        { candidate_id: 'c-1', team_mailbox_id: 'tm-2', step_id: null, as_of: '2026-09-30T10:00:00Z', id: 'a-3' },
      ],
    };
    // e-1 is mixed (shared and tm-3); e-t is tm-3's alone. tm-1 has no event but a live stream; tm-2's stream ended.
    const rows = [input('e-1', null), input('e-1', 'tm-3'), input('e-t', 'tm-3', 'rules')];
    const saved: Array<Record<string, unknown>> = [];
    const { db } = fakePagedSupabase(tables, (name, args) => {
      if (name === 'discovery_audience_assessment_inputs') return { data: rows, error: null };
      saved.push(args);
      return args.p_team_mailbox_id === 'tm-1' ? { data: null, error: { code: '22023' } } : { data: true, error: null };
    });
    const store = supabaseExtractStore(db);
    const [work] = await store.candidatesToAssess(DEV_TENANT_ID, []);
    expect(work.events.map((e) => [e.id, e.basis])).toEqual([['e-1', 'model']]);
    expect(work.teams.map((t) => [t.teamMailboxId, t.events.map((e) => `${e.id}:${e.basis}`), t.live])).toEqual([
      ['tm-1', [], true],
      ['tm-3', ['e-1:model', 'e-t:rules'], false],
    ]);

    const a = assessStage(work.teams[1].events, MVP_DEAL_RAIL);
    expect(await store.saveAssessment(DEV_TENANT_ID, 'c-1', a, 'correction', { teamMailboxId: 'tm-3', basis: 'mixed' })).toBe(true);
    expect(saved.at(-1)).toMatchObject({ p_team_mailbox_id: 'tm-3', p_assessment: { basis: 'mixed', stepId: 'p4-s48' } });
    await expect(store.saveAssessment(DEV_TENANT_ID, 'c-1', assessStage([], MVP_DEAL_RAIL), 'correction', { teamMailboxId: 'tm-1' }))
      .rejects.toBeInstanceOf(TeamInboxRefusedError);
    expect(saved.at(-1)?.p_assessment).not.toHaveProperty('basis');
    // The shared row names no inbox, and its own failures are never read as a refused inbox.
    await store.saveAssessment(DEV_TENANT_ID, 'c-1', a, 'correction', { teamMailboxId: null, basis: 'model' });
    expect(saved.at(-1)).not.toHaveProperty('p_team_mailbox_id');
  });
});

describe('runExtractOnce on the synthetic path', () => {
  it('prices a live call from its tokens: usage is recorded once per gateway call, keyed by the response id', async () => {
    const m = memoryExtractStore(DEMO_GRAPH_DIR);
    const transport = modelReplyDouble(TABLE, { kind: 'gateway', usage: SONNET_USAGE });
    const summary = await runExtractOnce({ tenantId: DEV_TENANT_ID, transport, store: m.store, env: SYNTHETIC_ENV });
    expect(summary.path).toBe('synthetic');
    expect(m.usage).toHaveLength(summary.sent);
    expect(m.usage[0]).toMatchObject({ model: 'anthropic/claude-sonnet-5', inputTokens: 500, outputTokens: 40 });
    expect(new Set(m.usage.map((u) => u.externalId)).size).toBe(m.usage.length);
    expect(m.calls.every((c) => c.transport === 'gateway' && c.inputTokens === 500)).toBe(true);
  });

  it('stops the batch at once when the plan has no ZDR (403, D90), and warns once', async () => {
    __resetWarnOnceForTests();
    const m = memoryExtractStore(DEMO_GRAPH_DIR);
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ type: 'error', error: { type: 'permission_denied', message: 'Zero Data Retention (ZDR) is only available for Pro and Enterprise plans' } }), { status: 403 }),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const waits: number[] = [];
    const summary = await runExtractOnce({
      tenantId: DEV_TENANT_ID,
      transport: gatewayTransport({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch }),
      store: m.store,
      env: SYNTHETIC_ENV,
      sleep: async (ms) => void waits.push(ms),
    });
    expect(summary.selected).toBeGreaterThan(1);
    expect(waits).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // no retry, no second item, no other path
    expect(summary).toMatchObject({ sent: 1, failed: 1, ok: 0 });
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]).toMatchObject({ outcome: 'failed', errorCode: 'zdr_unavailable', transport: 'gateway' });
    expect(m.usage).toHaveLength(0);
    expect(summary.stoppedBy).toBe('zdr_unavailable');
    // Settled before the stop: the refused item is not left in flight for the next pass to count as unpriced.
    expect(m.budget!.inflight.size).toBe(0);
    expect((await m.store.budgetState(DEV_TENANT_ID))!.unpriced).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe(`[discovery_extract] ${ZDR_REFUSED_MESSAGE}`);
    warn.mockRestore();
  });

  it('asks again on a no-provider refusal (400), then stops the batch once it outlasts the retries (D106)', async () => {
    __resetWarnOnceForTests();
    const m = memoryExtractStore(DEMO_GRAPH_DIR);
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ type: 'error', error: { type: 'no_providers_available', message: 'No ZDR (Zero Data Retention) providers available for model x' } }), { status: 400 }),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const waits: number[] = [];
    const summary = await runExtractOnce({
      tenantId: DEV_TENANT_ID,
      transport: gatewayTransport({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch }),
      store: m.store,
      env: SYNTHETIC_ENV,
      sleep: async (ms) => void waits.push(ms),
    });
    expect(waits).toEqual([...ZDR_RETRY_DELAYS_MS]);
    expect(fetchImpl).toHaveBeenCalledTimes(1 + ZDR_RETRY_DELAYS_MS.length); // one item, asked again; no second item
    expect(summary).toMatchObject({ sent: 1, failed: 1, stoppedBy: 'zdr_unavailable' });
    // The retries ride on the item's one reservation (#261 x D106): one call row, counted once at the item's
    // ceiling, the same in this pass and in the budget state; settled, so nothing is left in flight.
    expect(m.calls).toHaveLength(1);
    expect(m.budget!.inflight.size).toBe(0);
    const state = (await m.store.budgetState(DEV_TENANT_ID))!;
    expect(state.unpriced).toBe(0);
    expect(summary.budget!.passSpendUsd).toBeGreaterThan(0);
    expect(summary.budget!.passSpendUsd).toBeCloseTo(state.spentUsd, 6);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  // A stop (SIGTERM) during the retries ends them: the refusal in hand is the final attempt, recorded and
  // counted at the item's ceiling and settled exactly as one that outlasted them, so the task leaves inside
  // its 40 s stopTimeout instead of being killed with the reservation still set.
  it.each([
    ['ends the default wait at once', false],
    ['does not ask again after an injected wait', true],
  ])('a stop during a ZDR retry %s, and the item is settled at its ceiling (D106)', async (_name, injected) => {
    __resetWarnOnceForTests();
    const m = memoryExtractStore(DEMO_GRAPH_DIR);
    const stop = new AbortController();
    const fetchImpl = vi.fn(async () => {
      if (!injected) setTimeout(() => stop.abort(), 5); // lands while the 15 s wait is running
      return new Response(JSON.stringify({ type: 'error', error: { type: 'no_providers_available', message: 'No ZDR providers' } }), { status: 400 });
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const started = Date.now();
    const summary = await runExtractOnce({
      tenantId: DEV_TENANT_ID,
      transport: gatewayTransport({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch }),
      store: m.store,
      env: SYNTHETIC_ENV,
      signal: stop.signal,
      ...(injected ? { sleep: async () => void stop.abort() } : {}),
    });
    expect(Date.now() - started).toBeLessThan(ZDR_RETRY_DELAYS_MS[0]);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // not asked again, no second item
    expect(summary).toMatchObject({ sent: 1, failed: 1, stoppedBy: 'zdr_unavailable' });
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]).toMatchObject({ outcome: 'failed', errorCode: 'zdr_unavailable' });
    // Fail closed: counted at the item's ceiling, the same in this pass and in the budget state; nothing in flight.
    expect(m.budget!.inflight.size).toBe(0);
    const state = (await m.store.budgetState(DEV_TENANT_ID))!;
    expect(state.unpriced).toBe(0);
    expect(summary.budget!.passSpendUsd).toBeGreaterThan(0);
    expect(summary.budget!.passSpendUsd).toBeCloseTo(state.spentUsd, 6);
    warn.mockRestore();
  });

  it('carries on when a no-provider ZDR refusal clears on the retry (#625, D106)', async () => {
    const m = memoryExtractStore(DEMO_GRAPH_DIR);
    const replies = modelReplyDouble(TABLE, { kind: 'gateway', usage: SONNET_USAGE }); // priced, so the bound does not stop it (#261)
    let refusals = 1;
    const transport: ModelTransport = {
      kind: 'gateway',
      async send(req) {
        if (refusals-- > 0) return { ok: false, outcome: 'failed', code: 'zdr_unavailable', zdrReason: 'no_providers_available', transport: 'gateway', latencyMs: 0 };
        return replies.send(req);
      },
    };
    const waits: number[] = [];
    const summary = await runExtractOnce({
      tenantId: DEV_TENANT_ID,
      transport,
      store: m.store,
      env: SYNTHETIC_ENV,
      sleep: async (ms) => void waits.push(ms),
    });
    expect(waits).toEqual([ZDR_RETRY_DELAYS_MS[0]]);
    expect(summary.stoppedBy).toBeUndefined();
    expect(summary.capped).toBeNull();
    expect(summary.failed).toBe(0);
    expect(summary.sent).toBe(summary.selected);
    // One call row and one ledger row per item, not per attempt: the refused attempt is not counted twice.
    expect(m.calls).toHaveLength(summary.sent);
    expect(m.usage).toHaveLength(summary.sent);
    expect(m.budget!.inflight.size).toBe(0);
  });

  it('counts an item outside the corpus as skipped and never sends it', async () => {
    const m = memoryExtractStore(DEMO_GRAPH_DIR);
    const real = m.store.batch;
    m.store.batch = async (...args) => [
      ...(await real(...args)),
      {
        id: '<invented-001@bank.example>',
        internetMessageId: '<invented-001@bank.example>',
        contentHash: 'h',
        subject: 'Project Kestrel: not committed mail',
        sentAt: null,
        bodyText: 'Anything.',
        attempt: 1,
      },
    ];
    // With usage: without it the first ok call is unpriced and stops the pass (B1).
    const transport = modelReplyDouble(TABLE, { kind: 'gateway', usage: SONNET_USAGE });
    const summary = await runExtractOnce({ tenantId: DEV_TENANT_ID, transport, store: m.store, env: SYNTHETIC_ENV });
    expect(summary.skippedNotSynthetic).toBe(1);
    expect(summary.sent).toBe(summary.selected - 1);
    expect(transport.sent).not.toContain('<invented-001@bank.example>');
  });
});

describe('runExtractOnce refuses before reading any mail', () => {
  it('on a gateway transport without the selection variable', async () => {
    const m = memoryExtractStore(DEMO_GRAPH_DIR);
    let batches = 0;
    const real = m.store.batch;
    m.store.batch = async (...a) => (batches++, real(...a));
    const transport = modelReplyDouble(TABLE, { kind: 'gateway' });
    await expect(
      runExtractOnce({ tenantId: DEV_TENANT_ID, transport, store: m.store, env: { NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:55521' } }),
    ).rejects.toBeInstanceOf(ProcessorRefusedError);
    expect(batches).toBe(0);
    expect(transport.sent).toEqual([]);
  });

  it('for an unlisted tenant on an open policy', async () => {
    const m = memoryExtractStore(DEMO_GRAPH_DIR);
    let batches = 0;
    const real = m.store.batch;
    m.store.batch = async (...a) => (batches++, real(...a));
    const transport = modelReplyDouble(TABLE, { kind: 'gateway', usage: SONNET_USAGE });
    await expect(runExtractOnce({ tenantId: DEV_TENANT_ID, transport, store: m.store, env: HOSTED_PROD, policy: OPEN })).rejects.toMatchObject({
      why: 'tenant_not_verified',
    });
    expect(batches).toBe(0);
    expect(transport.sent).toEqual([]);
  });

  it('for an unpinned model on the verified path', async () => {
    const m = memoryExtractStore(DEMO_GRAPH_DIR);
    const transport = modelReplyDouble(TABLE, { kind: 'gateway', usage: SONNET_USAGE });
    await expect(
      runExtractOnce({ tenantId: PILOT, transport, store: m.store, env: { ...HOSTED_PROD, DISCOVERY_EXTRACT_MODEL: 'anthropic/claude-haiku-4-5' }, policy: OPEN }),
    ).rejects.toMatchObject({ why: 'model_not_verified' });
    expect(transport.sent).toEqual([]);
  });

  it('on a Fable model, even for a recorded transport', async () => {
    const m = memoryExtractStore(DEMO_GRAPH_DIR);
    await expect(
      runExtractOnce({ tenantId: DEV_TENANT_ID, transport: modelReplyDouble(TABLE), store: m.store, env: { DISCOVERY_EXTRACT_MODEL: 'anthropic/claude-fable-5' } }),
    ).rejects.toMatchObject({ why: 'covered_model' });
  });
});

describe('runExtractOnce on the verified path', () => {
  it('sends every item for the listed tenant, with no corpus filter', async () => {
    const m = memoryExtractStore(DEMO_GRAPH_DIR);
    const transport = modelReplyDouble(TABLE, { kind: 'gateway', usage: SONNET_USAGE });
    const summary = await runExtractOnce({ tenantId: PILOT, transport, store: m.store, env: HOSTED_PROD, policy: OPEN });
    expect(summary).toMatchObject({ path: 'verified', skippedNotSynthetic: 0, failed: 0 });
    expect(summary.sent).toBe(summary.selected);
  });
});

describe('runExtractOnce is bounded by its estimate', () => {
  const gw = (o: Parameters<typeof modelReplyDouble>[1] = {}) => modelReplyDouble(TABLE, { kind: 'gateway', usage: SONNET_USAGE, ...o });
  const run = (m: ReturnType<typeof memoryExtractStore>, transport = gw(), extra = {}) =>
    runExtractOnce({ tenantId: DEV_TENANT_ID, transport, store: m.store, env: SYNTHETIC_ENV, ...extra });
  const stateOf = async (m: ReturnType<typeof memoryExtractStore>) => (await m.store.budgetState(DEV_TENANT_ID))!;
  const SONNET_COST = 0.0014; // (500 * 2 + 40 * 10) / 1e6

  it('opens one budget with its cohort on the first gateway pass, and prints the estimate once', async () => {
    const m = memoryExtractStore(DEMO_GRAPH_DIR);
    const estimates: unknown[] = [];
    const s = await run(m, gw(), { onEstimate: (e: unknown) => estimates.push(e) });
    expect(s).toMatchObject({ opened: true, capped: null });
    expect(estimates).toHaveLength(1);
    expect(m.control.opened).toBe(1);
    expect(m.budget!.cohort.size).toBe(s.budget!.itemCount);
  });

  it('opens nothing when no mail is pending, and sends nothing', async () => {
    const m = memoryExtractStore(DEMO_GRAPH_DIR);
    await run(m, gw(), { limit: 200 });
    m.closeBudget();
    const transport = gw();
    expect(await run(m, transport)).toMatchObject({ opened: false, budget: null, capped: null, selected: 0, sent: 0 });
    expect(transport.sent).toEqual([]);
    expect(m.control.opened).toBe(1);
  });

  describe('B1: the ledger cannot fail open', () => {
    it('an ok call with no usage writes a null row keyed on its response id and stops; the next pass sends nothing', async () => {
      const m = memoryExtractStore(DEMO_GRAPH_DIR);
      const s = await run(m, gw({ usage: undefined }));
      expect(s).toMatchObject({ capped: 'unpriced', sent: 1 });
      expect(m.ledger).toEqual([expect.objectContaining({ externalId: 'msg_double_1', costUsd: null })]);
      expect(m.calls).toHaveLength(1); // and the call itself is on record
      const next = gw();
      expect(await run(m, next)).toMatchObject({ capped: 'unpriced', sent: 0 });
      expect(next.sent).toEqual([]);
    });

    it('an ok call on a model the price table does not know is unpriced too', async () => {
      const m = memoryExtractStore(DEMO_GRAPH_DIR);
      const s = await run(m, gw({ usage: { ...SONNET_USAGE, model: 'anthropic/not-in-pricing' } }));
      expect(s).toMatchObject({ capped: 'unpriced', sent: 1 });
      expect(m.ledger).toEqual([expect.objectContaining({ externalId: 'msg_double_1', costUsd: null })]);
    });

    it('an ok call with no response id writes a null row keyed local:<uuid>, never an empty key', async () => {
      const m = memoryExtractStore(DEMO_GRAPH_DIR);
      const s = await run(m, gw({ responseId: () => '' }));
      expect(s).toMatchObject({ capped: 'unpriced', sent: 1 });
      expect(m.ledger).toEqual([expect.objectContaining({ externalId: expect.stringMatching(/^local:[0-9a-f-]{36}$/), costUsd: null })]);
      expect(m.ledger.every((r) => r.externalId !== '')).toBe(true);
      expect(m.calls[0].responseId).toBeNull();
      const next = gw();
      expect(await run(m, next)).toMatchObject({ capped: 'unpriced', sent: 0 });
    });

    it('a ledger write error stops the pass, and the restarted process sees the gap as unpriced', async () => {
      const m = memoryExtractStore(DEMO_GRAPH_DIR);
      m.control.failLedgerOnce = true;
      await expect(run(m)).rejects.toThrow('record ai usage failed: ledger');
      expect(m.calls).toHaveLength(1); // the call row is still saved, so the gap is visible
      const next = gw();
      expect(await run(m, next)).toMatchObject({ capped: 'unpriced', sent: 0 });
      expect(next.sent).toEqual([]);
    });

    it('a billed ok call whose call row cannot be saved is in the spend, and the item is not sent again', async () => {
      const m = memoryExtractStore(DEMO_GRAPH_DIR);
      m.control.failSaveCallOnce = true;
      const first = gw();
      await expect(run(m, first)).rejects.toThrow('record extraction failed');
      expect(m.calls).toEqual([]);
      expect(m.ledger).toEqual([expect.objectContaining({ externalId: 'msg_double_1', costUsd: expect.any(Number) })]);
      const state = await stateOf(m);
      // The ledgered cost, plus the reservation the failed write left set, at the item's ceiling: a conservative double count.
      expect(state.spentUsd).toBeCloseTo(SONNET_COST + m.budget!.cohort.get(first.sent[0])!, 6);
      expect(state.unpriced).toBeGreaterThan(0); // a ledger row no call row matches, and a reservation never settled
      const next = gw();
      expect(await run(m, next)).toMatchObject({ capped: 'unpriced', sent: 0 });
      expect(next.sent).toEqual([]);
    });

    it('a failed call whose call row cannot be saved leaves an unpriced local row, and the item is not sent again', async () => {
      const m = memoryExtractStore(DEMO_GRAPH_DIR);
      m.control.failSaveCallOnce = true;
      await expect(run(m, gw({ failAllWith: 'timeout' }))).rejects.toThrow('record extraction failed');
      expect(m.calls).toEqual([]);
      expect(m.ledger).toEqual([expect.objectContaining({ externalId: expect.stringMatching(/^local:/), costUsd: null })]);
      const next = gw();
      expect(await run(m, next)).toMatchObject({ capped: 'unpriced', sent: 0 });
      expect(next.sent).toEqual([]);
    });

    it('a no_key failure whose call row cannot be saved writes no row: nothing left the process', async () => {
      const m = memoryExtractStore(DEMO_GRAPH_DIR);
      m.control.failSaveCallOnce = true;
      await expect(run(m, gw({ failAllWith: 'no_key' }))).rejects.toThrow('record extraction failed');
      expect(m.ledger).toEqual([]);
    });

    it('a timed-out call counts at its ceiling; a no_key failure counts nothing', async () => {
      const timeouts = memoryExtractStore(DEMO_GRAPH_DIR);
      const transport = gw({ failAllWith: 'timeout' });
      const s = await run(timeouts, transport, { limit: 2 });
      expect(transport.sent).toHaveLength(2);
      const ceilings = transport.sent.reduce((sum, id) => sum + timeouts.budget!.cohort.get(id)!, 0);
      const state = await stateOf(timeouts);
      expect(state.spentUsd).toBeCloseTo(ceilings, 6);
      expect(state.unpriced).toBe(0);
      expect(s.budget!.passSpendUsd).toBeCloseTo(state.spentUsd, 6);

      const noKey = memoryExtractStore(DEMO_GRAPH_DIR);
      const none = await run(noKey, gw({ failAllWith: 'no_key' }), { limit: 2 });
      expect(none.sent).toBe(2);
      expect(none.budget!.passSpendUsd).toBe(0);
      expect((await stateOf(noKey)).spentUsd).toBe(0);
    });
  });

  describe('M-1: a reservation before every send', () => {
    /** The extraction branch of ModelRequest; a deal_proposal request carries no item id. */
    const sourceItemIdOf = (req: ModelRequest): string => {
      if (req.purpose !== 'milestone_extract') throw new Error(`expected milestone_extract, got ${req.purpose}`);
      return req.sourceItemId;
    };

    /** A transport that dies mid-call, as a SIGKILL does: the item left, the reply never came back. */
    const dying = (): ModelTransport & { sent: string[] } => {
      const sent: string[] = [];
      return {
        kind: 'gateway',
        sent,
        async send(req) {
          sent.push(sourceItemIdOf(req));
          throw new Error('SIGKILL');
        },
      };
    };

    it('reserves the item before it is sent and settles it after the call is on record', async () => {
      const m = memoryExtractStore(DEMO_GRAPH_DIR);
      const seen: Array<{ reserved: boolean; calls: number }> = [];
      const inner = gw();
      const probing: ModelTransport & { sent: string[] } = {
        kind: 'gateway',
        sent: inner.sent,
        async send(req) {
          seen.push({ reserved: m.budget!.inflight.has(sourceItemIdOf(req)), calls: m.calls.length });
          return inner.send(req);
        },
      };
      const s = await run(m, probing, { limit: 3 });
      expect(s.sent).toBe(3);
      expect(seen.map((x) => x.reserved)).toEqual([true, true, true]); // reserved before every send, one at a time
      expect(m.budget!.inflight.size).toBe(0); // and settled after each
      expect((await stateOf(m)).unpriced).toBe(0);
    });

    it('settles a failed call and a no_key failure too', async () => {
      for (const code of ['timeout', 'no_key'] as const) {
        const m = memoryExtractStore(DEMO_GRAPH_DIR);
        await run(m, gw({ failAllWith: code }), { limit: 2 });
        expect(m.budget!.inflight.size, code).toBe(0);
        expect((await stateOf(m)).unpriced, code).toBe(0);
      }
    });

    it('(a) a reservation that cannot be written sends nothing and stops the pass', async () => {
      const m = memoryExtractStore(DEMO_GRAPH_DIR);
      m.control.failReserveOnce = true;
      const transport = gw();
      await expect(run(m, transport)).rejects.toThrow('reserve extract call failed');
      expect(transport.sent).toEqual([]);
      expect(m.calls).toEqual([]);
      expect(m.ledger).toEqual([]);
      expect(m.budget!.inflight.size).toBe(0);
    });

    it('(b) a billed call whose ledger write and call row both fail is counted at its ceiling and never re-sent', async () => {
      const m = memoryExtractStore(DEMO_GRAPH_DIR);
      m.control.failLedgerOnce = true;
      m.control.failSaveCallOnce = true;
      const first = gw();
      await expect(run(m, first)).rejects.toThrow('record extraction failed');
      expect(first.sent).toHaveLength(1);
      expect(m.calls).toEqual([]); // nothing was written: the database refused every write
      expect(m.ledger).toEqual([]);
      const state = await stateOf(m);
      expect(state.spentUsd).toBeCloseTo(m.budget!.cohort.get(first.sent[0])!, 6); // the item's ceiling
      expect(state.unpriced).toBeGreaterThan(0);
      const next = gw();
      expect(await run(m, next)).toMatchObject({ capped: 'unpriced', sent: 0 });
      expect(next.sent).toEqual([]);
    });

    it('(c) a call killed mid-flight leaves its reservation: the next pass counts it at its ceiling and sends nothing', async () => {
      const m = memoryExtractStore(DEMO_GRAPH_DIR);
      const killed = dying();
      await expect(run(m, killed)).rejects.toThrow('SIGKILL');
      expect(killed.sent).toHaveLength(1);
      expect(m.calls).toEqual([]);
      const state = await stateOf(m);
      expect(state.spentUsd).toBeCloseTo(m.budget!.cohort.get(killed.sent[0])!, 6);
      expect(state.unpriced).toBe(1);
      const next = gw();
      expect(await run(m, next)).toMatchObject({ capped: 'unpriced', sent: 0 });
      expect(next.sent).toEqual([]);
    });

    it('a settle that fails after the call is on record still stops the next pass', async () => {
      const m = memoryExtractStore(DEMO_GRAPH_DIR);
      m.control.failSettleOnce = true;
      await expect(run(m)).rejects.toThrow('settle extract call failed');
      expect(m.calls).toHaveLength(1);
      const next = gw();
      expect(await run(m, next)).toMatchObject({ capped: 'unpriced', sent: 0 });
      expect(next.sent).toEqual([]);
    });

    it('renewing the budget (closing it) lifts the stop', async () => {
      const m = memoryExtractStore(DEMO_GRAPH_DIR);
      await expect(run(m, dying())).rejects.toThrow('SIGKILL');
      m.closeBudget();
      const next = gw();
      expect(await run(m, next, { limit: 1 })).toMatchObject({ opened: true, capped: null, sent: 1 });
    });
  });

  describe('B2: the stop line is checked before every call', () => {
    it('stops before a call that would cross the line, not after', async () => {
      const m = memoryExtractStore(DEMO_GRAPH_DIR);
      await run(m, gw(), { limit: 1 });
      const st = await stateOf(m);
      const nextCeiling = Math.max(...m.budget!.cohort.values());
      m.seedSpend(st.stopAtUsd - st.spentUsd - nextCeiling / 2); // the next call's ceiling no longer fits
      const transport = gw();
      const s = await run(m, transport);
      expect(s.capped).toBe('over_estimate');
      expect(transport.sent).toEqual([]);
      const after = await stateOf(m);
      expect(after.spentUsd).toBeLessThanOrEqual(after.stopAtUsd);
    });

    it('never sends an item whose ceiling alone crosses the line', async () => {
      const m = memoryExtractStore(DEMO_GRAPH_DIR);
      await run(m, gw(), { limit: 1 });
      m.budget!.stopAtUsd = (await stateOf(m)).spentUsd + 1e-6; // a line no call fits under
      const transport = gw();
      expect(await run(m, transport)).toMatchObject({ capped: 'over_estimate', sent: 0 });
      expect(transport.sent).toEqual([]);
    });

    it('counts what this pass has already spent: calls that each fit alone stop once together they cross the line', async () => {
      const m = memoryExtractStore(DEMO_GRAPH_DIR);
      const usage = { model: 'anthropic/claude-sonnet-5', inputTokens: 3000, outputTokens: 600 };
      const actual = (3000 * 2 + 600 * 10) / 1e6; // 0.012 a call
      await run(m, gw({ usage }), { limit: 0 }); // opens the budget, sends nothing
      const ceilings = [...m.budget!.cohort.values()]; // in the order the batch sends them
      // The line must admit calls 1..k by their actual cost, refuse call k+1 once passSpend is counted, and
      // admit call k+1 if only spent + its ceiling were counted (the line is at or above that ceiling).
      let chosen: { k: number; stop: number } | null = null;
      for (let k = 2; k < ceilings.length && !chosen; k++) {
        const lowest = Math.max(ceilings[k], ...ceilings.slice(0, k).map((c, j) => c + j * actual));
        const highest = ceilings[k] + k * actual; // exclusive: call k+1 must not fit
        if (lowest < highest) chosen = { k, stop: Math.round(((lowest + highest) / 2) * 1e6) / 1e6 };
      }
      expect(chosen, 'the demo cohort has a stop line that separates passSpend from spent + ceiling').not.toBeNull();
      m.budget!.stopAtUsd = chosen!.stop;
      const transport = gw({ usage });
      const s = await run(m, transport, { limit: 200 });
      expect(ceilings[chosen!.k]).toBeLessThanOrEqual(chosen!.stop); // call k+1 would fit on spent + ceiling alone
      expect(transport.sent).toHaveLength(chosen!.k);
      expect(s).toMatchObject({ sent: chosen!.k, capped: 'over_estimate' });
      expect(s.budget!.passSpendUsd).toBeCloseTo(chosen!.k * actual, 6);
    });

    it('a pass over the whole cohort stays under the stop line', async () => {
      const m = memoryExtractStore(DEMO_GRAPH_DIR);
      const s = await run(m, gw(), { limit: 200 });
      expect(s.capped).toBeNull();
      expect(s.budget!.passSpendUsd).toBeCloseTo(s.sent * SONNET_COST, 6);
      const after = await stateOf(m);
      expect(after.spentUsd).toBeLessThanOrEqual(after.stopAtUsd);
    });
  });

  describe('m-3: a budget is spent only under the model and prompt it was opened for', () => {
    it('sends nothing and says so when the open budget is for another model', async () => {
      const m = memoryExtractStore(DEMO_GRAPH_DIR);
      await run(m, gw(), { limit: 1 });
      m.budget!.model = 'anthropic/claude-haiku-4-5';
      const transport = gw();
      expect(await run(m, transport)).toMatchObject({ capped: 'budget_model_mismatch', sent: 0, selected: 0 });
      expect(transport.sent).toEqual([]);
    });

    it('sends nothing when the open budget is for another prompt version', async () => {
      const m = memoryExtractStore(DEMO_GRAPH_DIR);
      await run(m, gw(), { limit: 1 });
      m.budget!.promptVersion = 'v0';
      const transport = gw();
      expect(await run(m, transport)).toMatchObject({ capped: 'budget_model_mismatch', sent: 0 });
      expect(transport.sent).toEqual([]);
    });

    it('a stopped pass still answers a correction, and the budget_open refusal is a distinct error', async () => {
      const m = memoryExtractStore(DEMO_GRAPH_DIR);
      await run(m, gw(), { limit: 200 });
      m.budget!.model = 'anthropic/claude-haiku-4-5';
      m.ask('codename:kestrel');
      const transport = gw();
      expect(await run(m, transport)).toMatchObject({ capped: 'budget_model_mismatch', sent: 0 });
      expect(m.outbox).toEqual([]);
      const e = estimateExtraction(await m.store.extractStats(DEV_TENANT_ID, 'v1', 'anthropic/claude-sonnet-5'));
      await expect(m.store.openBudget(DEV_TENANT_ID, e, 'v1')).rejects.toThrow('P0004');
    });
  });

  describe('m-4: the budget compares the cohort it builds', () => {
    it('refuses an equal count with larger bodies: nothing opens and nothing is sent', async () => {
      const m = memoryExtractStore(DEMO_GRAPH_DIR);
      const real = m.store.extractStats;
      // The estimate was made over smaller bodies than the ones now pending: the same count, one byte short.
      m.store.extractStats = async (...a) => {
        const stats = await real(...a);
        return { ...stats, bodyBytes: { ...stats.bodyBytes, total: stats.bodyBytes.total - 1 } };
      };
      const transport = gw();
      const s = await run(m, transport);
      // Mail to send and no budget to send it under: the pass says so (no_budget) rather than reading as idle.
      expect(s).toMatchObject({ opened: false, budget: null, capped: 'no_budget', selected: 0, sent: 0 });
      expect(transport.sent).toEqual([]);
      expect(m.control.opened).toBe(0);
      expect(m.budget).toBeNull();
    });
  });

  describe('M1: the cohort', () => {
    it('new mail waits for the next budget', async () => {
      const m = memoryExtractStore(DEMO_GRAPH_DIR);
      await run(m, gw(), { limit: 3 });
      const cohort = new Set(m.budget!.cohort.keys());
      m.addLateMail();
      const transport = gw();
      await run(m, transport, { limit: 200 });
      expect(transport.sent.length).toBeGreaterThan(0);
      expect(transport.sent.every((id) => cohort.has(id))).toBe(true);
      m.closeBudget();
      const fresh = gw();
      const s = await run(m, fresh, { limit: 200 });
      expect(s.opened).toBe(true);
      expect(fresh.sent.some((id) => !cohort.has(id))).toBe(true);
    });
  });

  describe('the reservation is one check across processes', () => {
    /** A gateway double whose reply waits a timer turn, so two passes over one store interleave. */
    const slow = (inner = gw()): ModelTransport & { sent: string[] } => ({
      kind: 'gateway',
      sent: inner.sent,
      async send(req) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return inner.send(req);
      },
    });
    /** Runs `after` once this pass has read its state and its batch: what another process does meanwhile. */
    const meanwhile = (m: ReturnType<typeof memoryExtractStore>, after: (ids: string[]) => void) => {
      const real = m.store.batch;
      m.store.batch = async (...a) => {
        const items = await real(...a);
        after(items.map((i) => i.id));
        return items;
      };
    };

    it('two interleaved passes never send one item twice and never cross the stop line', async () => {
      const m = memoryExtractStore(DEMO_GRAPH_DIR);
      await run(m, gw(), { limit: 0 }); // opens the budget, sends nothing
      const ceilings = [...m.budget!.cohort.values()];
      m.budget!.stopAtUsd = Math.round((ceilings.reduce((a, c) => a + c, 0) / 2) * 1e6) / 1e6; // about half the cohort
      const a = slow();
      const b = slow();
      const [sa, sb] = await Promise.all([run(m, a, { limit: 200 }), run(m, b, { limit: 200 })]);
      const sent = [...a.sent, ...b.sent];
      expect(sent.length).toBeGreaterThan(0);
      expect(new Set(sent).size).toBe(sent.length);
      expect([sa.capped, sb.capped]).toContain('busy'); // the second process found the first one's call in flight
      const after = await stateOf(m);
      expect(after.spentUsd).toBeLessThanOrEqual(after.stopAtUsd);
      expect(m.budget!.inflight.size).toBe(0);
    });

    it("another process's call in flight stops the pass at the reservation: busy, nothing sent", async () => {
      const m = memoryExtractStore(DEMO_GRAPH_DIR);
      await run(m, gw(), { limit: 0 });
      meanwhile(m, (ids) => m.budget!.inflight.set(ids[1], 0));
      const transport = gw();
      expect(await run(m, transport)).toMatchObject({ capped: 'busy', sent: 0 });
      expect(transport.sent).toEqual([]);
    });

    it('a budget closed after this pass read it stops the pass: closed, nothing sent', async () => {
      const m = memoryExtractStore(DEMO_GRAPH_DIR);
      await run(m, gw(), { limit: 0 });
      meanwhile(m, () => m.closeBudget());
      const transport = gw();
      expect(await run(m, transport)).toMatchObject({ capped: 'closed', sent: 0 });
      expect(transport.sent).toEqual([]);
    });

    it("spend another process recorded after this pass read its state stops the pass at the reservation", async () => {
      const m = memoryExtractStore(DEMO_GRAPH_DIR);
      await run(m, gw(), { limit: 0 });
      meanwhile(m, () => m.seedSpend(m.budget!.stopAtUsd)); // the line is reached between this pass's check and its send
      const transport = gw();
      expect(await run(m, transport)).toMatchObject({ capped: 'over_estimate', sent: 0 });
      expect(transport.sent).toEqual([]);
    });

    it('answers each code in the order discovery_extract_reserve checks them', async () => {
      const m = memoryExtractStore(DEMO_GRAPH_DIR);
      await run(m, gw(), { limit: 1 });
      const id = m.budget!.id;
      const answered = m.calls[0].sourceItemId;
      const [first, second] = [...m.budget!.cohort.keys()].filter((k) => k !== answered);
      const reserve = (item: string, budget = id) => m.store.reserveCall(DEV_TENANT_ID, budget, item);
      expect(await reserve(first, 'budget-none')).toBe('closed');
      expect(await reserve('<not-in-cohort@bank.example>')).toBe('not_in_cohort');
      expect(await reserve(answered)).toBe('busy'); // answered since the opening: a stale batch never sends it again
      const stop = m.budget!.stopAtUsd;
      m.budget!.stopAtUsd = (await stateOf(m)).spentUsd + m.budget!.cohort.get(first)! - 1e-6;
      expect(await reserve(first)).toBe('over_estimate');
      m.budget!.stopAtUsd = stop;
      expect(await reserve(first)).toBe('ok');
      expect(await reserve(first)).toBe('busy'); // a second reserve of the same item
      expect(await reserve(second)).toBe('busy');
      await m.store.settleCall(DEV_TENANT_ID, id, first);
      m.seedSpend(null);
      expect(await reserve(second)).toBe('unpriced');
      expect(m.budget!.inflight.size).toBe(0); // nothing but ok wrote a reservation
    });

    it('refuses an item the batch has given up on (three failures) as busy: a stale batch never sends a fourth attempt', async () => {
      const m = memoryExtractStore(DEMO_GRAPH_DIR);
      for (let i = 0; i < 3; i++) await run(m, gw({ failAllWith: 'timeout' }), { limit: 1 });
      const item = m.calls[0].sourceItemId;
      expect(m.calls.filter((c) => c.sourceItemId === item && c.outcome === 'failed')).toHaveLength(3);
      expect(await m.store.reserveCall(DEV_TENANT_ID, m.budget!.id, item)).toBe('busy');
      expect(m.budget!.inflight.size).toBe(0);
    });
  });

  describe('a stop (SIGTERM) ends the pass between items', () => {
    it('an aborted signal sends nothing, and a correction is still answered', async () => {
      const m = memoryExtractStore(DEMO_GRAPH_DIR);
      await run(m, gw(), { limit: 1 });
      m.ask('codename:kestrel');
      const stop = new AbortController();
      stop.abort();
      const transport = gw();
      expect(await run(m, transport, { signal: stop.signal })).toMatchObject({ capped: null, sent: 0 });
      expect(transport.sent).toEqual([]);
      expect(m.outbox).toEqual([]);
    });

    it('a stop that lands while the reservation is written releases it unsent', async () => {
      const m = memoryExtractStore(DEMO_GRAPH_DIR);
      const stop = new AbortController();
      const real = m.store.reserveCall;
      m.store.reserveCall = async (...a) => {
        const r = await real(...a);
        stop.abort(); // SIGTERM arrives after the reservation is on record, before the send
        return r;
      };
      const transport = gw();
      expect(await run(m, transport, { limit: 200, signal: stop.signal })).toMatchObject({ capped: null, sent: 0 });
      expect(transport.sent).toEqual([]);
      expect(m.budget!.inflight.size).toBe(0);
      expect((await stateOf(m)).unpriced).toBe(0);
    });

    it('a stop mid-pass finishes and settles the call in hand, then sends nothing further', async () => {
      const m = memoryExtractStore(DEMO_GRAPH_DIR);
      const stop = new AbortController();
      const inner = gw();
      const stopping: ModelTransport & { sent: string[] } = {
        kind: 'gateway',
        sent: inner.sent,
        async send(req) {
          stop.abort(); // SIGTERM arrives while the first call is out
          return inner.send(req);
        },
      };
      const s = await run(m, stopping, { limit: 200, signal: stop.signal });
      expect(s).toMatchObject({ sent: 1, ok: 1, capped: null });
      expect(stopping.sent).toHaveLength(1);
      expect(m.budget!.inflight.size).toBe(0);
      expect((await stateOf(m)).unpriced).toBe(0);
    });
  });

  it('a recorded pass reads nothing while a budget is open: the batch answers only the budget it names', async () => {
    const m = memoryExtractStore(DEMO_GRAPH_DIR);
    await run(m, gw(), { limit: 1 });
    const replay = modelReplyDouble(TABLE);
    expect(await runExtractOnce({ tenantId: DEV_TENANT_ID, transport: replay, store: m.store, env: {} })).toMatchObject({ selected: 0, sent: 0 });
    expect(await m.store.batch(DEV_TENANT_ID, 'v1', 'anthropic/claude-sonnet-5', 50, 'budget-other')).toEqual([]);
    expect((await m.store.batch(DEV_TENANT_ID, 'v1', 'anthropic/claude-sonnet-5', 50, m.budget!.id)).length).toBeGreaterThan(0);
  });

  describe('restart persistence', () => {
    it('the next process reuses the open budget and the spend so far', async () => {
      const m = memoryExtractStore(DEMO_GRAPH_DIR);
      await run(m, gw(), { limit: 3 });
      const before = await stateOf(m);
      const s = await run(m, gw(), { limit: 3 }); // a new process: a fresh transport and loop over the same database
      expect(m.control.opened).toBe(1);
      expect(s.opened).toBe(false);
      expect(s.budget).toMatchObject({ itemCount: before.itemCount, spentUsd: before.spentUsd }); // the state at this pass's check
      expect((await stateOf(m)).spentUsd).toBeGreaterThan(before.spentUsd); // and after its sends
    });
  });

  it('a stopped pass still answers a correction (no model call)', async () => {
    const m = memoryExtractStore(DEMO_GRAPH_DIR);
    await run(m, gw(), { limit: 200 });
    m.seedSpend(1e6);
    m.ask('codename:kestrel'); // the cluster-key form the recompute tests use
    const transport = gw();
    const s = await run(m, transport);
    expect(s.capped).toBe('over_estimate');
    expect(transport.sent).toEqual([]);
    expect(m.outbox).toEqual([]);
  });

  it('refuses when the budget cannot be read', async () => {
    const m = memoryExtractStore(DEMO_GRAPH_DIR);
    m.store.budgetState = async () => {
      throw new Error('read extract budget failed: 42501');
    };
    await expect(run(m)).rejects.toThrow('read extract budget failed');
  });

  it('a recorded replay never reads a budget, and the summary carries numbers and codes only', async () => {
    const m = memoryExtractStore(DEMO_GRAPH_DIR);
    let reads = 0;
    const real = m.store.budgetState;
    m.store.budgetState = async (...a) => (reads++, real(...a));
    const s = await runExtractOnce({ tenantId: DEV_TENANT_ID, transport: modelReplyDouble(TABLE), store: m.store, env: {} });
    expect(s).toMatchObject({ path: 'recorded', capped: null, budget: null });
    expect(reads).toBe(0);
    expect(JSON.stringify(s)).not.toContain(DEV_TENANT_ID);
  });

  it('the estimate prints the ceiling ratio next to the expected one', () => {
    expect(estimateExtraction({ items: 1, threads: 1, bodyBytes: describeSizes([100]), subjectBytes: describeSizes([5]) }).assumptions)
      .toMatchObject({ bytesPerToken: 3.0, ceilingBytesPerToken: CEILING_BYTES_PER_TOKEN });
    expect(CEILING_BYTES_PER_TOKEN).toBe(2.0);
  });
});

describe('the SQL and TS ceilings agree (m-6)', () => {
  const probe = readFileSync(join(process.cwd(), 'supabase/tests/discovery_milestones.sql'), 'utf8');
  const item = (c: { subjectBytes: number; bodyBytes: number }) => ({ subject: 'a'.repeat(c.subjectBytes), bodyText: 'b'.repeat(c.bodyBytes) });

  it('pins the model, the prices and the ratio the SQL probe is called with', () => {
    expect(ceilingCases.model).toBe(DEFAULT_EXTRACT_MODEL);
    expect(ceilingCases.bytesPerToken).toBe(CEILING_BYTES_PER_TOKEN);
    const p = ceilingPrices(ceilingCases.model);
    expect(p.inputUsdPerToken).toBeCloseTo(ceilingCases.inputUsdPerToken, 12);
    expect(p.outputCeilingUsd).toBeCloseTo(ceilingCases.outputCeilingUsd, 12);
    expect(ceilingCases.cases.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...ceilingCases.cases.map((c) => c.bodyBytes))).toBeGreaterThanOrEqual(200_000);
  });

  it.each(ceilingCases.cases)('ceilingCostFor matches the fixture: $name', (c) => {
    expect(ceilingCostFor(item(c), ceilingCases.model, ceilingCases.overheadBytes)).toBeCloseTo(Number(c.expectedCeilingUsd), 6);
  });

  it('ceilingCostFor uses the prompt overhead by default and the dense ratio, not the expected-cost one', () => {
    const c = ceilingCases.cases[1];
    const bytes = OVERHEAD_BYTES_PER_ITEM + c.subjectBytes + c.bodyBytes;
    const expected = Math.ceil(bytes / 2.0) * ceilingCases.inputUsdPerToken + ceilingCases.outputCeilingUsd;
    expect(ceilingCostFor(item(c))).toBeCloseTo(expected, 6);
    expect(ceilingCostFor(item(c))).toBeGreaterThan(Math.ceil(bytes / 3.0) * ceilingCases.inputUsdPerToken + ceilingCases.outputCeilingUsd);
  });

  it('the SQL probe asserts every expected value and is called with the fixture inputs', () => {
    for (const c of ceilingCases.cases) {
      expect(probe, c.name).toContain(`'${c.expectedCeilingUsd}'`);
      expect(probe, c.name).toContain(`${c.subjectBytes + c.bodyBytes}, ${ceilingCases.overheadBytes}, ${ceilingCases.bytesPerToken.toFixed(1)}`);
    }
    expect(probe).toContain(String(ceilingCases.inputUsdPerToken)); // 0.000002
    expect(probe).toContain(String(ceilingCases.outputCeilingUsd)); // 0.02048
  });
});
