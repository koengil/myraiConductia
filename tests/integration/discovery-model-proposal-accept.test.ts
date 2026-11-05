import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/*
 * Demo only (#460), G-02b (#173). Accepting a model-only proposal, against a REAL database, through the whole path:
 *
 *   demo corpus -> runOnce (the rules leave some of Storm's mail unrouted, ledgered with its hash)
 *   -> three model proposal rows for those messages under one m: key (the writer, as the propose run calls it)
 *   -> discovery_accept_model_proposal as Alice (the owner) -> a pending request
 *   -> one row changes after the accept -> the source's SYNC job (createWorkerHandlers.sync) runs its accept step
 *   -> the keyed messages are stored and routed `model_proposal`, linked to a model:u:<owner>:<slug> candidate, and
 *      their proposal rows are re-keyed to c:<candidate>; the changed row stays under m: and its message is not stored
 *   -> the candidate has no station, no pin and no deal; a later pass keeps the route; Alice promotes it through
 *      POST /api/v1/deals/from-discovery, where the station is hers to choose.
 *
 * What is real: the classification worker (the normal pass, then the accept step and its guarded read), the
 * definers, the upsert, RLS, the promotion route. What is faked: how a handler obtains the signed-in client (the cookie
 * layer needs Next). The mailbox guard admits the fixture sources the way every discovery integration test sets them up
 * (tests/integration/helpers/discoveryTenant.ts). Flags are set for the file and restored.
 */

import { createDiscoveryTenant, DEMO_LATE_MAIL_DIRECTORY } from './helpers/discoveryTenant';

const harness = createDiscoveryTenant('ma');

vi.mock('@/lib/supabase/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/supabase/server')>();
  return { ...actual, createSupabaseServerClient: async () => harness.activeSession() };
});

import { POST as promoteRoute } from '@/app/api/v1/deals/from-discovery/route';
import { READER_MODE } from '@/lib/constants/discovery';
import { messageKey } from '@/lib/discovery/propose/key';
import { proposedStepFor } from '@/lib/discovery/propose/station';
import { createWorkerHandlers } from '../../worker/classify';

const { db, tenantId, users } = harness;
const STORM = 'storm.duncan@bank.example';
const DEAL_KEY = 'm:project-heron';
// The canonical station of the group's highest phase (phase 3, p3-s39), the only step the accept RPC records, from
// the same helper the list uses; the request records it and never writes it as a station.
const STEP = proposedStepFor('phase-3');
const RUN = '0b9a1c3e-5d7f-4a2b-8c4d-6e8f0a1b2c3d';
const JOB = crypto.randomUUID();
const ENTRY_SEQ = 48; // the MD's own choice at promotion
const today = () => new Date().toISOString().slice(0, 10);

const FLAGS = ['discovery_worker_enabled', 'discovery_model_proposals_demo', 'company_access_management'] as const;
const previousFlags = new Map<string, { enabled: boolean } | null>();
async function setFlag(key: string, enabled: boolean): Promise<void> {
  const { error } = await db
    .from('feature_flags')
    .upsert({ key, description: `${key} (integration)`, enabled }, { onConflict: 'key' });
  if (error) throw new Error(`flag upsert failed: ${error.message}`);
}

/** Runs `work` with the fixture reader on the demo corpus with its late mail. */
async function onDemo<T>(work: () => Promise<T>): Promise<T> {
  const before = process.env.DISCOVERY_FIXTURE_DIR;
  process.env.DISCOVERY_FIXTURE_DIR = DEMO_LATE_MAIL_DIRECTORY;
  try {
    return await work();
  } finally {
    if (before === undefined) delete process.env.DISCOVERY_FIXTURE_DIR;
    else process.env.DISCOVERY_FIXTURE_DIR = before;
  }
}

const handlers = createWorkerHandlers({
  db,
  boss: { send: async () => 'job' } as never,
  provider: READER_MODE.FIXTURE,
});

let sourceId = '';
/** Three of Storm's messages the rules left unrouted: their Message-IDs and the content hashes the ledger holds. */
let mail: Array<{ id: string; key: string; hash: string }> = [];
let candidateId = '';
let requestId = '';
let operationId = '';

/** One proposal row for a message, through the writer, as the propose run calls it. */
async function record(message: { id: string; hash: string }, phase: string, hash = message.hash): Promise<void> {
  const { error } = await db.rpc('discovery_record_model_proposal', {
    p_tenant_id: tenantId,
    p_proposal: {
      content_source_id: sourceId,
      message_key: messageKey(message.id),
      item_hash: hash,
      sent_at: '2026-03-02T10:00:00Z',
      party_domains: ['osprey-capital.example'],
      outcome: 'deal',
      deal_key: DEAL_KEY,
      deal_name: 'Project Heron',
      candidate_id: null,
      phase,
      p_deal: 0.9,
      p_phase: 0.6,
      model: 'anthropic/claude-haiku-5.5',
      prompt_version: 'v1',
      prompt_hash: 'hash-v1',
      response_id: null,
      run_id: RUN,
    },
  });
  if (error) throw new Error(`proposal record failed: ${error.message}`);
}

const proposalsOf = async (key: string) =>
  (await db.from('discovery_model_proposals').select('message_key, deal_key, candidate_id').eq('tenant_id', tenantId).eq('content_source_id', sourceId).like('deal_key', key)).data ?? [];

// A routed ledger row keeps no Message-ID (persist.ts ledgerRows: the ids are kept only while a row is unrouted), so
// the rows are found by the provider ids this source read each message under, recorded while it was still unrouted.
const providerIdsOf = new Map<string, string[]>();
const ledgerOf = async (id: string) =>
  (
    await db
      .from('routing_ledger')
      .select('decision, method, confidence')
      .eq('source_id', sourceId)
      .in('provider_item_id', providerIdsOf.get(id) ?? [])
  ).data ?? [];

const itemOf = async (id: string) =>
  (await db.from('source_items').select('id').eq('tenant_id', tenantId).eq('internet_message_id', id)).data ?? [];

const requestRow = async () => {
  const { data, error } = await db.from('discovery_model_proposal_accepts').select('*').eq('id', requestId).single();
  if (error) throw new Error(`request read failed: ${error.message}`);
  return data as Record<string, unknown>;
};

beforeAll(async () => {
  await harness.setup();
  for (const key of FLAGS) {
    const { data } = await db.from('feature_flags').select('enabled').eq('key', key).maybeSingle();
    previousFlags.set(key, data as { enabled: boolean } | null);
    await setFlag(key, true);
  }
  await harness.seedDemo(DEMO_LATE_MAIL_DIRECTORY);
  sourceId = await harness.sourceIdOf(STORM);

  const { data, error } = await db
    .from('routing_ledger')
    .select('internet_message_id, item_hash, provider_item_id')
    .eq('source_id', sourceId)
    .eq('decision', 'unrouted')
    .not('internet_message_id', 'is', null)
    .order('internet_message_id');
  if (error) throw new Error(`ledger read failed: ${error.message}`);
  const seen = new Set<string>();
  for (const row of data ?? []) {
    const id = row.internet_message_id as string;
    providerIdsOf.set(id, [...(providerIdsOf.get(id) ?? []), row.provider_item_id as string]);
    if (seen.has(id)) continue;
    seen.add(id);
    mail.push({ id, key: messageKey(id), hash: row.item_hash as string });
  }
  mail = mail.slice(0, 3);
  if (mail.length < 3) throw new Error('the demo corpus left fewer than three of Storm\'s messages unrouted');
});

afterAll(async () => {
  // The requests go with the source (on delete cascade); the proposal rows are not tied to the candidates.
  await db.from('discovery_model_proposals').delete().eq('tenant_id', tenantId);
  await db.from('content_sources').delete().eq('tenant_id', tenantId);
  await harness.cleanup();
  for (const [key, previous] of previousFlags) {
    if (previous) await setFlag(key, previous.enabled);
    else await db.from('feature_flags').delete().eq('key', key);
  }
});

describe('the request', () => {
  it('starts with three unrouted messages, no text stored for them, and three live proposal rows', async () => {
    await record(mail[0], 'phase-2');
    await record(mail[1], 'phase-3');
    await record(mail[2], 'phase-3');
    expect(await proposalsOf(DEAL_KEY)).toHaveLength(3);
    for (const message of mail) {
      expect((await ledgerOf(message.id)).map((r) => r.decision)).toEqual(['unrouted']);
      expect(await itemOf(message.id)).toEqual([]);
    }
  });

  it('refuses a colleague without deal-create authority with 42501, before reading any row, and records nothing', async () => {
    // Authority first (140100's header): the answer does not depend on the key, so it reveals nothing about it.
    const { error } = await harness.sessionFor('colleague').rpc('discovery_accept_model_proposal', {
      p_deal_key: DEAL_KEY,
      p_proposed_step_id: STEP,
    });
    expect(error?.code).toBe('42501');
    expect((await db.from('discovery_model_proposal_accepts').select('id').eq('tenant_id', tenantId)).data).toEqual([]);
  });

  it('refuses a colleague WITH deal-create authority who does not own the mailbox with P0002, and records nothing', async () => {
    const seatAs = async (role: 'director' | 'member') => {
      const { error } = await db.from('users').update({ company_role: role }).eq('id', users.colleague.id);
      if (error) throw new Error(`reseating the colleague failed: ${error.message}`);
    };
    await seatAs('director');
    try {
      const { error } = await harness.sessionFor('colleague').rpc('discovery_accept_model_proposal', {
        p_deal_key: DEAL_KEY,
        p_proposed_step_id: STEP,
      });
      expect(error?.code).toBe('P0002');
    } finally {
      await seatAs('member');
    }
    expect((await db.from('discovery_model_proposal_accepts').select('id').eq('tenant_id', tenantId)).data).toEqual([]);
  });

  it('records one pending request for Alice, and a repeat returns the same operation and writes nothing', async () => {
    const first = await harness.sessionFor('alice').rpc('discovery_accept_model_proposal', {
      p_deal_key: DEAL_KEY,
      p_proposed_step_id: STEP,
    });
    expect(first.error).toBeNull();
    expect(first.data).toEqual([{ operation_id: expect.any(String), request_count: 1 }]);
    operationId = first.data![0].operation_id as string;

    const repeat = await harness.sessionFor('alice').rpc('discovery_accept_model_proposal', {
      p_deal_key: DEAL_KEY,
      p_proposed_step_id: STEP,
    });
    expect(repeat.data).toEqual([{ operation_id: operationId, request_count: 0 }]);

    const { data } = await db.from('discovery_model_proposal_accepts').select('id, state, email_count, placed_count').eq('tenant_id', tenantId);
    expect(data).toEqual([{ id: expect.any(String), state: 'pending', email_count: 3, placed_count: 2 }]);
    requestId = data![0].id as string;
  });

  it('a row that changes between the accept and the job is no longer live', async () => {
    await record(mail[2], 'phase-3', 'f'.repeat(64));
    expect((await proposalsOf(DEAL_KEY)).map((r) => r.message_key).sort()).toEqual(mail.map((m) => m.key).sort());
  });
});

describe("the source's SYNC job serves the request", () => {
  it('stores, routes and links only the two live messages, and finishes the request', async () => {
    const result = await onDemo(() => handlers.sync({ tenantId, sourceId }, { jobId: JOB }));
    expect(result).toMatchObject({ status: expect.stringMatching(/complete|page_limit/) });

    const row = await requestRow();
    expect(row).toMatchObject({
      state: 'done',
      failure_code: null,
      found_count: 2,
      changed_count: 1,
      purged_count: 0,
      // The claim token is the attempt's reader pass id, not the pg-boss job id (a retry keeps its job id).
      claim_token: expect.not.stringMatching(JOB),
    });
    expect((row.storing_keys as string[]).slice().sort()).toEqual([mail[0].key, mail[1].key].sort());
    candidateId = row.candidate_id as string;
    expect(candidateId).toEqual(expect.any(String));

    for (const message of mail.slice(0, 2)) {
      expect(await ledgerOf(message.id)).toEqual([{ decision: 'routed', method: 'model_proposal', confidence: 1 }]);
      expect(await itemOf(message.id)).toHaveLength(1);
    }
    // The changed message was never stored and stays unrouted.
    expect((await ledgerOf(mail[2].id)).map((r) => r.decision)).toEqual(['unrouted']);
    expect(await itemOf(mail[2].id)).toEqual([]);
  });

  it('makes a proposed candidate with no station, no pin, no deal, linked to exactly the two messages', async () => {
    const { data: candidate } = await db
      .from('deal_candidates')
      .select('cluster_key, proposed_name, codename_guess, discovery_state, pinned, station_override_step_id, station_override_correction_id, promoted_deal_id')
      .eq('id', candidateId)
      .single();
    expect(candidate).toEqual({
      cluster_key: `model:u:${users.alice.id}:project-heron`,
      proposed_name: 'Project Heron',
      codename_guess: null,
      discovery_state: 'proposed',
      pinned: false,
      station_override_step_id: null,
      station_override_correction_id: null,
      promoted_deal_id: null,
    });
    const { data: links } = await db.from('evidence_links').select('method, route_tier, state').eq('candidate_id', candidateId);
    expect(links).toEqual([
      { method: 'model_proposal', route_tier: 'firm', state: expect.any(String) },
      { method: 'model_proposal', route_tier: 'firm', state: expect.any(String) },
    ]);
    // Nothing but the fixture deal that seats the mailbox owners exists: no mandate, no cursor.
    expect((await db.from('deals').select('id').eq('tenant_id', tenantId).neq('id', harness.fixtureDealId)).data).toEqual([]);
  });

  it('re-keys the linked proposal rows to the candidate, leaves the changed one under m:, and the owner reads both', async () => {
    expect((await proposalsOf(DEAL_KEY)).map((r) => r.message_key)).toEqual([mail[2].key]);
    const moved = await proposalsOf(`c:${candidateId}`);
    expect(moved.map((r) => r.message_key).sort()).toEqual([mail[0].key, mail[1].key].sort());
    for (const row of moved) expect(row.candidate_id).toBe(candidateId);

    const own = await harness
      .sessionFor('alice')
      .from('discovery_model_proposals')
      .select('message_key')
      .eq('deal_key', `c:${candidateId}`);
    expect(own.data).toHaveLength(2);
    // The colleague reads neither the request nor the re-keyed rows.
    const other = await harness.sessionFor('colleague').from('discovery_model_proposals').select('message_key').eq('deal_key', `c:${candidateId}`);
    expect(other.data).toEqual([]);
  });

  it('records the correction and two audit rows with ids and counts only', async () => {
    const corrections = (await db.from('corrections').select('action, actor_id').eq('candidate_id', candidateId)).data ?? [];
    expect(corrections).toEqual([{ action: 'accept_proposal', actor_id: users.alice.id }]);

    const audit = (
      await db
        .from('audit_log')
        .select('action, actor_type, service_identity, detail')
        .eq('tenant_id', tenantId)
        .in('action', ['discovery.model_proposal_accept_requested', 'discovery.model_proposal_accept_finished'])
    ).data ?? [];
    const byAction = Object.fromEntries(audit.map((a) => [a.action as string, a]));
    expect(audit).toHaveLength(2);
    expect(byAction['discovery.model_proposal_accept_requested'].detail).toMatchObject({ operationId, sourceCount: 1, messageCount: 3, proposedStepId: STEP });
    expect(byAction['discovery.model_proposal_accept_finished']).toMatchObject({
      actor_type: 'service',
      service_identity: 'discovery-worker',
      detail: { requestId, operationId, outcome: 'done', found: 2, requested: 3, changed: 1, purged: 0, candidateId },
    });
    const text = JSON.stringify(audit);
    expect(text).not.toMatch(/heron|project-heron|@/i);
    for (const message of mail) expect(text.includes(message.key) || text.includes(message.id)).toBe(false);
  });

  it('a later job claims nothing, and a later pass keeps the accepted messages routed', async () => {
    const before = JSON.stringify(await requestRow());
    await onDemo(() => handlers.sync({ tenantId, sourceId }, { jobId: crypto.randomUUID() }));
    expect(JSON.stringify(await requestRow())).toBe(before);
    for (const message of mail.slice(0, 2)) {
      expect(await ledgerOf(message.id)).toEqual([{ decision: 'routed', method: 'model_proposal', confidence: 1 }]);
    }
    expect(await itemOf(mail[2].id)).toEqual([]);
  });
});

describe('the station is the MD\'s to set', () => {
  it('Alice promotes the accepted candidate and chooses the entry station herself', async () => {
    harness.sessionFor('alice');
    const response = await promoteRoute(
      new Request('http://localhost/api/v1/deals/from-discovery', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          candidateId,
          codename: 'Project Heron',
          targetName: 'Northwind Robotics',
          entryStepSeq: ENTRY_SEQ,
          conflictsAttestation: { approvedBy: 'Avery Lindqvist', approvedOn: today() },
        }),
      }),
    );
    expect(response.status).toBe(201);
    const body = await response.json();

    const deal = (await db.from('deals').select('current_step_seq, entry_step_seq').eq('id', body.deal.id).single()).data;
    expect(deal).toEqual({ current_step_seq: ENTRY_SEQ, entry_step_seq: ENTRY_SEQ });
    const candidate = (await db.from('deal_candidates').select('discovery_state, promoted_deal_id').eq('id', candidateId).single()).data;
    expect(candidate).toEqual({ discovery_state: 'confirmed', promoted_deal_id: body.deal.id });
  });
});
