// @vitest-environment node
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import { MAILBOX_PROVIDER, SOURCE_KIND } from '@/lib/constants/discovery';
import { TABLE } from '@/lib/constants/tables';
import { normalizeMessage } from '@/lib/discovery/normalize';
import { messageKey, type LedgerRow } from '@/lib/discovery/persist';
import { MailboxAccessRefusedError } from '@/lib/mailboxAccess/guard';
import type { ContentSource, MailMessage, SourceItemPage, SourceRow } from '@/lib/discovery/source/types';
import { acceptStep, windowFromOf, type AcceptReadResult, type AcceptStepDeps } from '../../worker/accept';
import { RoutingContext, syncSource, type SyncSource } from '../../worker/sync';
import { memoryPersistDb } from './memoryPersistDb';

// The accept step inside the SYNC job (G-02b #173, design R4 and R6), over a fake that keeps the definers' contract:
// a token that does not match is a no-op, a finish purges the write-ahead keys that did not link, and a claim returns
// only what is due. The read is the real syncSource in accept mode over a scripted reader; the commit is the real
// persistItems over an in-memory store. What is under test is the order of the steps and what each one is allowed to do.

const TENANT = '11111111-1111-4111-8111-111111111111';
const SOURCE_ID = '33333333-3333-4333-8333-333333333333';
const RUN = '22222222-2222-4222-8222-222222222222';
const OWNER = '44444444-4444-4444-8444-444444444444';
const CLUSTER = `model:u:${OWNER}:project-heron`;

const source = (): SyncSource => ({
  id: SOURCE_ID,
  tenantId: TENANT,
  kind: SOURCE_KIND.MAILBOX,
  provider: MAILBOX_PROVIDER.GOOGLE,
  address: 'storm.duncan@bank.example',
  ownerUserId: OWNER,
  deltaCheckpoint: '{"phase":"delta"}',
  backfillCompletedAt: '2026-01-01T00:00:00Z',
});

function message(id: string, subject: string, over: Partial<MailMessage> = {}): MailMessage {
  return {
    id,
    internetMessageId: `<${id}@bank.example>`,
    conversationId: `conv-${id}`,
    subject,
    sentDateTime: '2026-03-02T09:00:00Z',
    from: { emailAddress: { name: 'Storm Duncan', address: 'storm.duncan@bank.example' } },
    toRecipients: [{ emailAddress: { name: 'Casey Buyer', address: 'casey@osprey-capital.example' } }],
    ccRecipients: [],
    body: { contentType: 'text', content: `Body of ${id}.` },
    ...over,
  };
}
const keyOf = (m: MailMessage) => messageKey(normalizeMessage(m).internetMessageId);
const hashOf = (m: MailMessage) => normalizeMessage(m).contentHash;
const page = (items: MailMessage[]): SourceItemPage => ({ items, nextCheckpoint: 'cp' });

/** A reader that serves the pages from nothing; `refuse` makes the guard say no before the first page. */
function scripted(pages: SourceItemPage[], options: { refuse?: boolean } = {}) {
  let asked = 0;
  const reader: ContentSource = {
    kind: SOURCE_KIND.MAILBOX,
    backfill: async function* (row: SourceRow) {
      asked += 1;
      if (options.refuse) throw new MailboxAccessRefusedError(TENANT, row.address, 'no_consent', 'provider_read');
      for (const current of pages) yield current;
    },
    delta: async function* () {
      throw new Error('an accept read never asks for a delta');
    },
  };
  return { reader, asked: () => asked };
}

/** A database that is never to be touched: the accept read stores nothing itself. */
const untouched = new Proxy({}, {
  get() {
    throw new Error('the accept read touched the database');
  },
}) as unknown as SupabaseClient;

/** The injected read: the real accept-mode syncSource, with a refusal turned into `unavailable` as classify.ts does. */
const readOver =
  (reader: ContentSource): AcceptStepDeps['read'] =>
  async (accept) => {
    try {
      const result = await syncSource(untouched, { source: source(), reader, runId: RUN, context: new RoutingContext(), accept });
      return { status: 'read', buffer: result.accepted! } satisfies AcceptReadResult;
    } catch (error) {
      if (error instanceof MailboxAccessRefusedError) return { status: 'unavailable' };
      throw error;
    }
  };

type Row = {
  id: string;
  tenant_id: string;
  content_source_id: string;
  deal_key: string;
  proposal_ids: string[];
  message_keys: string[];
  item_hashes: string[];
  cluster_key: string;
  state: 'pending' | 'running' | 'storing' | 'stored' | 'done' | 'failed';
  storing_keys: string[] | null;
  /** Due to be claimed: pending, or a live state whose lease ran out. */
  due: boolean;
  token: string | null;
  live: Array<{ message_key: string; item_hash: string; sent_at: string | null }>;
  finished?: { candidate: string | null; failure: string | null };
};

type ProposalRow = {
  id: string;
  message_key: string;
  item_hash: string;
  deal_name: string;
  party_domains: string[];
  sent_at: string;
};

/** One request over these messages, and the proposal rows its snapshot names. */
function request(id: string, messages: MailMessage[], over: Partial<Row> = {}) {
  const proposals: ProposalRow[] = messages.map((m, i) => ({
    id: `${id}-p${i}`,
    message_key: keyOf(m),
    item_hash: hashOf(m),
    deal_name: 'Project Heron',
    party_domains: ['osprey-capital.example'],
    sent_at: m.sentDateTime ?? '2026-03-02T09:00:00Z',
  }));
  const row: Row = {
    id,
    tenant_id: TENANT,
    content_source_id: SOURCE_ID,
    deal_key: 'm:project-heron',
    proposal_ids: proposals.map((p) => p.id),
    message_keys: proposals.map((p) => p.message_key),
    item_hashes: proposals.map((p) => p.item_hash),
    cluster_key: CLUSTER,
    state: 'pending',
    storing_keys: null,
    due: true,
    token: null,
    live: proposals.map((p) => ({ message_key: p.message_key, item_hash: p.item_hash, sent_at: p.sent_at })),
    ...over,
  };
  return { row, proposals };
}

const ok = <T>(data: T) => ({ data, error: null });

/** Chainable, awaitable query answering `data` whatever is asked of it. */
function answering(data: unknown) {
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'in', 'is']) builder[method] = () => builder;
  builder.then = (resolve: (value: unknown) => unknown) => Promise.resolve(ok(data)).then(resolve);
  return builder;
}

type FakeOptions = {
  crashOn?: string[];
  /** Overrides what the write-ahead returns for the keys it is given (the definer's answer); null is "token lost". */
  mark?: (keys: string[]) => string[] | null;
  /** Runs right after the write-ahead has answered, with the request it answered for. */
  afterStoring?: (row: Row) => void;
};

function fakeAccept(rows: Row[], proposals: ProposalRow[], options: FakeOptions = {}) {
  const mem = memoryPersistDb();
  const calls: Array<{ name: string; args: Record<string, any> }> = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  const events: string[] = [];
  const holders = new Set<string>();
  /** The provider ids each held item was read under (the holder rows' provider_item_id). */
  const holderPids = new Map<string, Set<string>>();
  const index = new Map<string, string[]>();
  const ledgerSelects: string[] = [];
  const crashOn = new Set(options.crashOn ?? []);

  /** An item this source already holds for a message, routed by `method`: its holder row, index row and ledger row. */
  const seedHeld = (m: MailMessage, itemId: string, method: string | null) => {
    holders.add(itemId);
    holderPids.set(itemId, new Set([m.id]));
    index.set(keyOf(m), [m.id]);
    mem.ledger.set(`${SOURCE_ID}\u0000${m.id}`, {
      source_id: SOURCE_ID,
      provider_item_id: m.id,
      decision: 'routed',
      method,
    } as unknown as LedgerRow);
  };
  /** A ledger row for a message the source has read but not stored. */
  const seedLedger = (m: MailMessage, decision: 'unrouted' | 'routed', method: string | null) => {
    mem.ledger.set(`${SOURCE_ID}\u0000${m.id}`, {
      source_id: SOURCE_ID,
      provider_item_id: m.id,
      decision,
      method,
    } as unknown as LedgerRow);
  };

  const purge = (keys: string[]) => {
    const gone = new Set(keys);
    for (const [id, item] of mem.items) if (gone.has(messageKey(id))) holders.delete(item.id);
  };

  const rpc = async (name: string, args: Record<string, any>) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    calls.push({ name, args });
    events.push(name);
    if (crashOn.delete(name)) throw new Error('simulated crash');
    const row = rows.find((r) => r.id === args.p_request);
    const mine = row !== undefined && row.token === args.p_token;
    switch (name) {
      case 'discovery_claim_model_proposal_accepts': {
        const due = rows.filter((r) => r.content_source_id === args.p_source && r.due);
        for (const r of due) {
          r.token = args.p_token;
          r.due = false;
          if (r.state === 'pending') r.state = 'running';
        }
        return ok(due.map((r) => ({ ...r })));
      }
      case 'discovery_renew_model_proposal_accept':
        return ok(mine && ['running', 'storing', 'stored'].includes(row.state));
      case 'discovery_model_proposal_accept_live_keys':
        if (!mine || !['running', 'storing'].includes(row.state)) return ok([]);
        return ok(row.live.filter((l) => row.state !== 'storing' || (row.storing_keys ?? []).includes(l.message_key)));
      case 'discovery_mark_model_proposal_accept_storing': {
        // Returns the keys the job may persist; null when the token is not the request's or its state is wrong.
        if (!mine || !['running', 'storing'].includes(row.state)) return ok(null);
        if (args.p_keys.some((k: string) => !row.live.some((l) => l.message_key === k))) {
          return { data: null, error: { code: '22023', message: 'keys_not_live' } };
        }
        let allowed: string[];
        if (row.state === 'storing') {
          // A reclaimed request keeps its write-ahead keys; the answer is those within the call's.
          allowed = args.p_keys.filter((k: string) => (row.storing_keys ?? []).includes(k));
        } else {
          const answer = options.mark ? options.mark(args.p_keys) : [...args.p_keys];
          if (answer === null) return ok(null);
          allowed = answer;
          row.state = 'storing';
          row.storing_keys = [...allowed];
        }
        options.afterStoring?.(row);
        return ok(allowed);
      }
      case 'discovery_mark_model_proposal_accept_stored':
        if (!mine || row.state !== 'storing') return ok(mine && row.state === 'stored');
        row.state = 'stored';
        return ok(true);
      case 'discovery_upsert_candidates':
        return ok([{ clusterKey: args.p_groups[0].clusterKey, candidateId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', created: true }]);
      case 'discovery_finish_model_proposal_accept': {
        if (!mine || !['running', 'storing', 'stored'].includes(row.state)) return ok(false);
        const keys = row.storing_keys ?? [];
        const linked = args.p_failure === null && args.p_candidate !== null;
        if (!linked) purge(keys);
        row.state = linked ? 'done' : 'failed';
        row.finished = { candidate: args.p_candidate, failure: args.p_failure };
        return ok(true);
      }
      case 'discovery_message_index_record':
        for (const r of args.p_rows as Array<{ provider_item_id: string; internet_message_id: string }>) {
          const key = messageKey(r.internet_message_id);
          index.set(key, [...new Set([...(index.get(key) ?? []), r.provider_item_id])]);
        }
        return mem.db.rpc(name, args);
      default:
        return mem.db.rpc(name, args);
    }
  };

  const from = (table: string) => {
    if (table === TABLE.DISCOVERY_MODEL_PROPOSALS) return answering(proposals);
    if (table === TABLE.DISCOVERY_MESSAGE_INDEX) {
      return answering([...index].map(([message_key, provider_item_ids]) => ({ message_key, provider_item_ids })));
    }
    const real = mem.db.from(table) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (table === TABLE.ROUTING_LEDGER) {
      // The writes (persistItems' upsert) stay the in-memory store's; only the read is answered here.
      return {
        ...real,
        select: (columns: string) => {
          ledgerSelects.push(columns);
          return answering(
            [...mem.ledger.values()].map((r) => ({
              source_id: r.source_id,
              provider_item_id: r.provider_item_id,
              decision: r.decision,
              method: r.method,
            })),
          );
        },
      };
    }
    if (table === TABLE.SOURCE_ITEMS) {
      return { ...real, upsert: (...a: unknown[]) => (events.push('persist'), real.upsert(...a)) };
    }
    if (table === TABLE.SOURCE_ITEM_SOURCES) {
      return {
        ...real,
        upsert: (items: Array<{ source_item_id: string; provider_item_id: string }>, ...rest: unknown[]) => {
          for (const item of items) {
            holders.add(item.source_item_id);
            holderPids.set(item.source_item_id, new Set([...(holderPids.get(item.source_item_id) ?? []), item.provider_item_id]));
          }
          return real.upsert(items, ...rest);
        },
        select: () =>
          answering(
            [...holders].flatMap((source_item_id) =>
              [...(holderPids.get(source_item_id) ?? [])].map((provider_item_id) => ({ source_item_id, provider_item_id })),
            ),
          ),
      };
    }
    return real;
  };

  return { db: { from, rpc } as unknown as SupabaseClient, calls, events, holders, index, mem, seedHeld, seedLedger, ledgerSelects };
}

const namesOf = (calls: Array<{ name: string }>) => calls.map((c) => c.name);

/** Collects what the step reports through onRequestError: the request id and the error. */
function collect() {
  const errors: Array<{ request: string; error: unknown }> = [];
  return { errors, report: (request: string, error: unknown) => void errors.push({ request, error }) };
}

const base = (fake: { db: SupabaseClient }, read: AcceptStepDeps['read'], over: Partial<AcceptStepDeps> = {}): AcceptStepDeps => ({
  db: fake.db,
  source: source(),
  token: 'job-1',
  runId: RUN,
  read,
  admitted: async () => true,
  pageBudget: 10,
  ...over,
});

describe('a pending request, served end to end', () => {
  it('records the keys before it writes, marks stored before the candidate, and finishes with the candidate', async () => {
    const m1 = message('m1', 'Heron update');
    const m2 = message('m2', 'Heron call', { sentDateTime: '2026-03-05T09:00:00Z' });
    const { row, proposals } = request('r1', [m1, m2]);
    const fake = fakeAccept([row], proposals);
    const { reader } = scripted([page([m1, m2, message('m3', 'Lunch on Friday')])]);

    const result = await acceptStep(base(fake, readOver(reader)));

    expect(result).toEqual({ claimed: 1, finished: 1 });
    const order = fake.events.filter((e) => e !== 'discovery_renew_model_proposal_accept' && e !== 'discovery_message_index_record');
    expect(order).toEqual([
      'discovery_claim_model_proposal_accepts',
      'discovery_model_proposal_accept_live_keys',
      'discovery_mark_model_proposal_accept_storing',
      'persist',
      'discovery_mark_model_proposal_accept_stored',
      'discovery_upsert_candidates',
      'discovery_finish_model_proposal_accept',
    ]);
    // Only the accepted messages were stored: the unrelated one is not in the store.
    expect([...fake.mem.items.keys()].sort()).toEqual(['<m1@bank.example>', '<m2@bank.example>']);
    expect(fake.mem.ledger.size).toBe(2);
    const storing = fake.calls.find((c) => c.name === 'discovery_mark_model_proposal_accept_storing')!;
    expect(storing.args).toMatchObject({ p_request: 'r1', p_token: 'job-1', p_keys: [keyOf(m1), keyOf(m2)].sort() });
    const finish = fake.calls.find((c) => c.name === 'discovery_finish_model_proposal_accept')!;
    expect(finish.args).toEqual({
      p_request: 'r1',
      p_token: 'job-1',
      p_candidate: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      p_failure: null,
    });
    expect(row.state).toBe('done');
  });

  it('upserts one group with codenameGuess null, the cluster key, the model_proposal links, parties and dates', async () => {
    const m1 = message('m1', 'Heron update');
    const m2 = message('m2', 'Heron call', { sentDateTime: '2026-03-05T09:00:00Z' });
    const { row, proposals } = request('r1', [m1, m2]);
    const fake = fakeAccept([row], proposals);

    await acceptStep(base(fake, readOver(scripted([page([m1, m2])]).reader)));

    const upsert = fake.calls.find((c) => c.name === 'discovery_upsert_candidates')!;
    expect(upsert.args.p_tenant_id).toBe(TENANT);
    expect(upsert.args.p_run_id).toBe(RUN);
    expect(upsert.args.p_groups).toHaveLength(1);
    const group = upsert.args.p_groups[0];
    expect(group).toMatchObject({
      clusterKey: CLUSTER,
      proposedName: 'Project Heron',
      codenameGuess: null,
      parties: [{ name: 'Osprey Capital', domain: 'osprey-capital.example' }],
      firstSeenAt: '2026-03-02T09:00:00.000Z',
      lastSeenAt: '2026-03-05T09:00:00.000Z',
      confidence: 1,
    });
    expect(group.codenameGuess).toBeNull();
    expect(group.links).toHaveLength(2);
    for (const link of group.links) expect(link).toMatchObject({ method: 'model_proposal', confidence: 1 });
    expect(new Set(group.links.map((l: { sourceItemId: string }) => l.sourceItemId))).toEqual(
      new Set([...fake.mem.items.values()].map((item) => item.id)),
    );
  });

  it('serves two requests on one source with ONE read, each committing only its own messages', async () => {
    const a = message('a1', 'Heron update');
    const b = message('b1', 'Kestrel update');
    const first = request('r1', [a]);
    const second = request('r2', [b], { deal_key: 'm:project-kestrel', cluster_key: `model:u:${OWNER}:project-kestrel` });
    const fake = fakeAccept([first.row, second.row], [...first.proposals, ...second.proposals]);
    const { reader, asked } = scripted([page([a, b])]);

    const result = await acceptStep(base(fake, readOver(reader)));

    expect(asked()).toBe(1);
    expect(result).toEqual({ claimed: 2, finished: 2 });
    const storing = fake.calls.filter((c) => c.name === 'discovery_mark_model_proposal_accept_storing');
    expect(storing.map((c) => [c.args.p_request, c.args.p_keys])).toEqual([
      ['r1', [keyOf(a)]],
      ['r2', [keyOf(b)]],
    ]);
    const upserts = fake.calls.filter((c) => c.name === 'discovery_upsert_candidates');
    expect(upserts.map((c) => c.args.p_groups[0].links.length)).toEqual([1, 1]);
  });

  it('the read asks for the union of the live keys and a window one day before the earliest message', async () => {
    const m1 = message('m1', 'Heron update', { sentDateTime: '2026-03-02T09:00:00Z' });
    const { row, proposals } = request('r1', [m1]);
    const fake = fakeAccept([row], proposals);
    let seen: Parameters<AcceptStepDeps['read']>[0] | undefined;
    await acceptStep(
      base(fake, async (accept) => {
        seen = accept;
        return readOver(scripted([page([m1])]).reader)(accept);
      }),
    );
    expect([...seen!.keys.keys()]).toEqual([keyOf(m1)]);
    expect(seen!.windowFrom).toBe('2026-03-01');
    expect(seen!.pageBudget).toBe(10);
    expect(typeof seen!.onPage).toBe('function');
  });

  it('renews every held request at each page', async () => {
    const m1 = message('m1', 'Heron update');
    const { row, proposals } = request('r1', [m1]);
    const fake = fakeAccept([row], proposals);
    await acceptStep(base(fake, readOver(scripted([page([m1])]).reader)));
    // One renewal for the page, and one right before the commit (the token and lease check before anything is written).
    const renewals = fake.calls.filter((c) => c.name === 'discovery_renew_model_proposal_accept');
    expect(renewals).toHaveLength(2);
    for (const renewal of renewals) {
      expect(renewal.args).toEqual({ p_request: 'r1', p_token: 'job-1', p_lease: '75 minutes' });
    }
    const names = namesOf(fake.calls);
    expect(names.indexOf('discovery_renew_model_proposal_accept')).toBeLessThan(
      names.indexOf('discovery_mark_model_proposal_accept_storing'),
    );
    expect(names.lastIndexOf('discovery_renew_model_proposal_accept')).toBeGreaterThan(
      names.indexOf('discovery_mark_model_proposal_accept_storing'),
    );
  });
});

describe('nothing to serve, or nothing readable', () => {
  it('claims nothing: no read and no other call', async () => {
    const fake = fakeAccept([], []);
    const read = async () => {
      throw new Error('no read expected');
    };
    expect(await acceptStep(base(fake, read))).toEqual({ claimed: 0, finished: 0 });
    expect(namesOf(fake.calls)).toEqual(['discovery_claim_model_proposal_accepts']);
  });

  it('no live key finishes failed none_readable, without a read', async () => {
    const m1 = message('m1', 'Heron update');
    const { row, proposals } = request('r1', [m1], { live: [] });
    const fake = fakeAccept([row], proposals);
    const read = async () => {
      throw new Error('no read expected');
    };
    expect(await acceptStep(base(fake, read))).toEqual({ claimed: 1, finished: 1 });
    expect(row.finished).toEqual({ candidate: null, failure: 'none_readable' });
  });

  it('a message gone from the mailbox finishes none_readable and records no write-ahead', async () => {
    const m1 = message('m1', 'Heron update');
    const { row, proposals } = request('r1', [m1]);
    const fake = fakeAccept([row], proposals);
    await acceptStep(base(fake, readOver(scripted([page([message('m9', 'Unrelated')])]).reader)));
    expect(row.finished).toEqual({ candidate: null, failure: 'none_readable' });
    expect(namesOf(fake.calls)).not.toContain('discovery_mark_model_proposal_accept_storing');
    expect(fake.mem.items.size).toBe(0);
  });

  it('a message whose text changed since the proposal is not stored', async () => {
    const original = message('m1', 'Heron update');
    const { row, proposals } = request('r1', [original]);
    const fake = fakeAccept([row], proposals);
    const edited = message('m1', 'Heron update', { body: { contentType: 'text', content: 'Rewritten.' } });
    await acceptStep(base(fake, readOver(scripted([page([edited])]).reader)));
    expect(row.finished).toEqual({ candidate: null, failure: 'none_readable' });
    expect(fake.mem.items.size).toBe(0);
  });

  it('a refusal finishes every claimed request failed source_unavailable and stores nothing', async () => {
    const m1 = message('m1', 'Heron update');
    const m2 = message('m2', 'Kestrel update');
    const first = request('r1', [m1]);
    const second = request('r2', [m2], { deal_key: 'm:project-kestrel', cluster_key: `model:u:${OWNER}:project-kestrel` });
    const fake = fakeAccept([first.row, second.row], [...first.proposals, ...second.proposals]);

    const result = await acceptStep(base(fake, readOver(scripted([page([m1, m2])], { refuse: true }).reader)));

    expect(result).toEqual({ claimed: 2, finished: 2 });
    expect(first.row.finished).toEqual({ candidate: null, failure: 'source_unavailable' });
    expect(second.row.finished).toEqual({ candidate: null, failure: 'source_unavailable' });
    expect(fake.mem.items.size).toBe(0);
    expect(fake.events).not.toContain('persist');
  });
});

describe('a crash, a retry and the purge', () => {
  it('a crash after the persist, then a refused retry, leaves no holder: the write-ahead keys are purged', async () => {
    const m1 = message('m1', 'Heron update');
    const { row, proposals } = request('r1', [m1]);
    const fake = fakeAccept([row], proposals, { crashOn: ['discovery_mark_model_proposal_accept_stored'] });

    // Job 1 stores the text and dies before it marks the request stored. The failure is the request's, reported by id.
    const failures = collect();
    await acceptStep(base(fake, readOver(scripted([page([m1])]).reader), { token: 'job-1', onRequestError: failures.report }));
    expect(failures.errors.map((e) => e.request)).toEqual(['r1']);
    expect(String(failures.errors[0].error)).toContain('simulated crash');
    expect(row.state).toBe('storing');
    expect(row.storing_keys).toEqual([keyOf(m1)]);
    expect(fake.holders.size).toBe(1);

    // The lease runs out; job 2 claims it, is refused by the guard, and the finish purges what job 1 wrote.
    row.due = true;
    const second = await acceptStep(base(fake, readOver(scripted([page([m1])], { refuse: true }).reader), { token: 'job-2' }));
    expect(second).toEqual({ claimed: 1, finished: 1 });
    expect(row.finished).toEqual({ candidate: null, failure: 'source_unavailable' });
    expect(fake.holders.size).toBe(0);
    expect(namesOf(fake.calls)).not.toContain('discovery_upsert_candidates');
  });

  it('a storing request is held to its write-ahead keys when it is claimed again', async () => {
    const m1 = message('m1', 'Heron update');
    const m2 = message('m2', 'Heron call');
    const { row, proposals } = request('r1', [m1, m2], { state: 'storing', storing_keys: [keyOf(m1)], token: 'job-1', due: true });
    const fake = fakeAccept([row], proposals);
    const { reader } = scripted([page([m1, m2])]);

    await acceptStep(base(fake, readOver(reader), { token: 'job-2' }));

    // m2 was never written ahead, so the retry may not store it.
    expect([...fake.mem.items.keys()]).toEqual(['<m1@bank.example>']);
  });

  it('a stored request resumes without a read, after the guard is asked again', async () => {
    const m1 = message('m1', 'Heron update');
    const { row, proposals } = request('r1', [m1]);
    const fake = fakeAccept([row], proposals, { crashOn: ['discovery_upsert_candidates'] });
    const failures = collect();
    await acceptStep(base(fake, readOver(scripted([page([m1])]).reader), { token: 'job-1', onRequestError: failures.report }));
    expect(failures.errors).toHaveLength(1);
    expect(row.state).toBe('stored');

    row.due = true;
    let guarded = 0;
    const read = async () => {
      throw new Error('a stored resume must not read');
    };
    const result = await acceptStep(
      base(fake, read, {
        token: 'job-2',
        admitted: async () => {
          guarded += 1;
          return true;
        },
      }),
    );

    expect(guarded).toBe(1);
    expect(result).toEqual({ claimed: 1, finished: 1 });
    const upsert = fake.calls.filter((c) => c.name === 'discovery_upsert_candidates').at(-1)!;
    expect(upsert.args.p_groups[0].links).toHaveLength(1);
    expect(upsert.args.p_groups[0].codenameGuess).toBeNull();
    expect(row.finished).toEqual({ candidate: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', failure: null });
  });

  it('a stored resume the guard refuses finishes source_unavailable, without a read, an upsert or a candidate', async () => {
    const m1 = message('m1', 'Heron update');
    const { row, proposals } = request('r1', [m1]);
    const fake = fakeAccept([row], proposals, { crashOn: ['discovery_upsert_candidates'] });
    const failures = collect();
    await acceptStep(base(fake, readOver(scripted([page([m1])]).reader), { token: 'job-1', onRequestError: failures.report }));
    expect(failures.errors).toHaveLength(1);

    row.due = true;
    const upsertsBefore = fake.calls.filter((c) => c.name === 'discovery_upsert_candidates').length;
    const read = async () => {
      throw new Error('a stored resume must not read');
    };
    await acceptStep(base(fake, read, { token: 'job-2', admitted: async () => false }));

    expect(row.finished).toEqual({ candidate: null, failure: 'source_unavailable' });
    expect(fake.calls.filter((c) => c.name === 'discovery_upsert_candidates')).toHaveLength(upsertsBefore);
    expect(fake.holders.size).toBe(0);
  });
});

describe('the ledger partition (this source decides what an accept may store and link)', () => {
  const ITEM = 'item-held-1';

  it('a key a rules method routed here is left to the rules: not written ahead, stored or linked', async () => {
    const m1 = message('m1', 'Heron update');
    const m2 = message('m2', 'Heron call');
    const { row, proposals } = request('r1', [m1, m2]);
    const fake = fakeAccept([row], proposals);
    fake.seedHeld(m1, ITEM, 'codename');

    const result = await acceptStep(base(fake, readOver(scripted([page([m1, m2])]).reader)));

    expect(result).toEqual({ claimed: 1, finished: 1 });
    const storing = fake.calls.filter((c) => c.name === 'discovery_mark_model_proposal_accept_storing');
    expect(storing.map((c) => c.args.p_keys)).toEqual([[keyOf(m2)]]);
    expect([...fake.mem.items.keys()]).toEqual(['<m2@bank.example>']);
    const links = fake.calls.find((c) => c.name === 'discovery_upsert_candidates')!.args.p_groups[0].links;
    expect(links).toHaveLength(1);
    expect(links.map((l: { sourceItemId: string }) => l.sourceItemId)).not.toContain(ITEM);
    // The rules' ledger row is untouched: the accept never overwrote it with model_proposal.
    expect(fake.mem.ledger.get(`${SOURCE_ID}\u0000m1`)?.method).toBe('codename');
    // The ledger read selects the provider id, the decision and the method, nothing else.
    expect(fake.ledgerSelects).toEqual(['provider_item_id, decision, method']);
  });

  it('keys all routed by rules finish none_readable with no write-ahead, no store and no candidate', async () => {
    const m1 = message('m1', 'Heron update');
    const { row, proposals } = request('r1', [m1]);
    const fake = fakeAccept([row], proposals);
    fake.seedHeld(m1, ITEM, 'thread_continuation');

    await acceptStep(base(fake, readOver(scripted([page([m1])]).reader)));

    expect(row.finished).toEqual({ candidate: null, failure: 'none_readable' });
    expect(namesOf(fake.calls)).not.toContain('discovery_mark_model_proposal_accept_storing');
    expect(namesOf(fake.calls)).not.toContain('discovery_upsert_candidates');
    expect(fake.events).not.toContain('persist');
  });

  it('a key an earlier accept routed model_proposal is linked and neither written ahead nor stored again', async () => {
    const m1 = message('m1', 'Heron update');
    const m2 = message('m2', 'Heron call');
    const { row, proposals } = request('r1', [m1, m2]);
    const fake = fakeAccept([row], proposals);
    fake.seedHeld(m1, ITEM, 'model_proposal');

    await acceptStep(base(fake, readOver(scripted([page([m1, m2])]).reader)));

    const storing = fake.calls.filter((c) => c.name === 'discovery_mark_model_proposal_accept_storing');
    expect(storing.map((c) => c.args.p_keys)).toEqual([[keyOf(m2)]]);
    expect([...fake.mem.items.keys()]).toEqual(['<m2@bank.example>']);
    const group = fake.calls.find((c) => c.name === 'discovery_upsert_candidates')!.args.p_groups[0];
    const linked = group.links.map((l: { sourceItemId: string }) => l.sourceItemId);
    expect(linked).toHaveLength(2);
    expect(linked).toContain(ITEM);
    expect(linked).toContain([...fake.mem.items.values()][0].id);
    expect(row.state).toBe('done');
  });

  it('only link-only keys: no write-ahead and no store, but the candidate is made and the request finishes done', async () => {
    const m1 = message('m1', 'Heron update');
    const { row, proposals } = request('r1', [m1]);
    const fake = fakeAccept([row], proposals);
    fake.seedHeld(m1, ITEM, 'model_proposal');

    await acceptStep(base(fake, readOver(scripted([page([m1])]).reader)));

    expect(namesOf(fake.calls)).not.toContain('discovery_mark_model_proposal_accept_storing');
    expect(fake.events).not.toContain('persist');
    const group = fake.calls.find((c) => c.name === 'discovery_upsert_candidates')!.args.p_groups[0];
    expect(group.links.map((l: { sourceItemId: string }) => l.sourceItemId)).toEqual([ITEM]);
    expect(row.finished).toEqual({ candidate: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', failure: null });
  });

  it('a key with no routed row here (unrouted, or never read) is written ahead and stored', async () => {
    const m1 = message('m1', 'Heron update');
    const m2 = message('m2', 'Heron call');
    const { row, proposals } = request('r1', [m1, m2]);
    const fake = fakeAccept([row], proposals);
    fake.seedLedger(m1, 'unrouted', null);

    await acceptStep(base(fake, readOver(scripted([page([m1, m2])]).reader)));

    const storing = fake.calls.find((c) => c.name === 'discovery_mark_model_proposal_accept_storing')!;
    expect(storing.args.p_keys).toEqual([keyOf(m1), keyOf(m2)].sort());
    expect([...fake.mem.items.keys()].sort()).toEqual(['<m1@bank.example>', '<m2@bank.example>']);
  });

  it('persists only the keys the write-ahead returns', async () => {
    const m1 = message('m1', 'Heron update');
    const m2 = message('m2', 'Heron call');
    const { row, proposals } = request('r1', [m1, m2]);
    const first = [keyOf(m1), keyOf(m2)].sort()[0];
    const fake = fakeAccept([row], proposals, { mark: (keys) => keys.filter((k) => k === first) });

    await acceptStep(base(fake, readOver(scripted([page([m1, m2])]).reader)));

    const kept = first === keyOf(m1) ? '<m1@bank.example>' : '<m2@bank.example>';
    expect([...fake.mem.items.keys()]).toEqual([kept]);
    expect(fake.calls.find((c) => c.name === 'discovery_upsert_candidates')!.args.p_groups[0].links).toHaveLength(1);
    expect(row.storing_keys).toEqual([first]);
  });

  it('a null write-ahead means the token was lost: the request is skipped, nothing is stored or finished', async () => {
    const m1 = message('m1', 'Heron update');
    const { row, proposals } = request('r1', [m1]);
    const fake = fakeAccept([row], proposals, { mark: () => null });

    const result = await acceptStep(base(fake, readOver(scripted([page([m1])]).reader)));

    expect(result).toEqual({ claimed: 1, finished: 0 });
    expect(fake.events).not.toContain('persist');
    expect(namesOf(fake.calls)).not.toContain('discovery_mark_model_proposal_accept_stored');
    expect(namesOf(fake.calls)).not.toContain('discovery_upsert_candidates');
    expect(namesOf(fake.calls)).not.toContain('discovery_finish_model_proposal_accept');
  });

  it('an empty write-ahead is valid: nothing is stored, the request is marked stored and finishes none_readable', async () => {
    const m1 = message('m1', 'Heron update');
    const { row, proposals } = request('r1', [m1]);
    const fake = fakeAccept([row], proposals, { mark: () => [] });

    const result = await acceptStep(base(fake, readOver(scripted([page([m1])]).reader)));

    expect(result).toEqual({ claimed: 1, finished: 1 });
    expect(fake.events).not.toContain('persist');
    expect(namesOf(fake.calls)).toContain('discovery_mark_model_proposal_accept_stored');
    expect(namesOf(fake.calls)).not.toContain('discovery_upsert_candidates');
    expect(row.finished).toEqual({ candidate: null, failure: 'none_readable' });
  });
});

describe('one request failing, and the lease before the commit', () => {
  it('a failing request does not stop the source\'s next one, and is reported by id', async () => {
    const a = message('a1', 'Heron update');
    const b = message('b1', 'Kestrel update');
    const first = request('r1', [a]);
    const second = request('r2', [b], { deal_key: 'm:project-kestrel', cluster_key: `model:u:${OWNER}:project-kestrel` });
    // The first write-ahead raises (as keys_not_live does); the second request's goes through.
    const fake = fakeAccept([first.row, second.row], [...first.proposals, ...second.proposals], {
      crashOn: ['discovery_mark_model_proposal_accept_storing'],
    });
    const failures = collect();

    const result = await acceptStep(base(fake, readOver(scripted([page([a, b])]).reader), { onRequestError: failures.report }));

    expect(failures.errors.map((e) => e.request)).toEqual(['r1']);
    expect(result).toEqual({ claimed: 2, finished: 1 });
    expect(first.row.state).toBe('running');
    expect(second.row.state).toBe('done');
    expect([...fake.mem.items.keys()]).toEqual(['<b1@bank.example>']);
  });

  it('a renew that answers false before the commit skips the commit', async () => {
    const m1 = message('m1', 'Heron update');
    const { row, proposals } = request('r1', [m1]);
    // Another job takes the request after the write-ahead: the pre-commit renew no longer finds this token.
    const fake = fakeAccept([row], proposals, { afterStoring: (r) => void (r.token = 'job-2') });

    const result = await acceptStep(base(fake, readOver(scripted([page([m1])]).reader)));

    expect(result).toEqual({ claimed: 1, finished: 0 });
    const names = namesOf(fake.calls);
    expect(names.filter((n) => n === 'discovery_renew_model_proposal_accept')).toHaveLength(2);
    expect(names.indexOf('discovery_renew_model_proposal_accept', names.indexOf('discovery_mark_model_proposal_accept_storing'))).toBeGreaterThan(-1);
    expect(fake.events).not.toContain('persist');
    expect(names).not.toContain('discovery_mark_model_proposal_accept_stored');
    expect(names).not.toContain('discovery_upsert_candidates');
    expect(fake.mem.items.size).toBe(0);
  });
});

describe('a job that no longer holds the request', () => {
  it('a duplicate job finds nothing due and does nothing', async () => {
    const m1 = message('m1', 'Heron update');
    const { row, proposals } = request('r1', [m1]);
    const fake = fakeAccept([row], proposals);
    await acceptStep(base(fake, readOver(scripted([page([m1])]).reader), { token: 'job-1' }));
    const before = fake.calls.length;

    const read = async () => {
      throw new Error('no read expected');
    };
    expect(await acceptStep(base(fake, read, { token: 'job-2' }))).toEqual({ claimed: 0, finished: 0 });
    expect(fake.calls.length).toBe(before + 1);
  });

  it('a superseded job writes nothing: the write-ahead answers false for its token', async () => {
    const m1 = message('m1', 'Heron update');
    const { row, proposals } = request('r1', [m1]);
    const fake = fakeAccept([row], proposals);
    const inner = readOver(scripted([page([m1])]).reader);

    const result = await acceptStep(
      base(fake, async (accept) => {
        const out = await inner(accept);
        row.token = 'job-2'; // another job claimed the request while this one read
        return out;
      }),
    );

    expect(result.finished).toBe(0);
    expect(fake.events).not.toContain('persist');
    expect(namesOf(fake.calls)).not.toContain('discovery_mark_model_proposal_accept_stored');
    expect(namesOf(fake.calls)).not.toContain('discovery_upsert_candidates');
    expect(row.state).toBe('running');
  });

  it('a lease lost during the read ends the step quietly with nothing written', async () => {
    const m1 = message('m1', 'Heron update');
    const { row, proposals } = request('r1', [m1]);
    const fake = fakeAccept([row], proposals);
    const inner = readOver(scripted([page([m1])]).reader);

    const result = await acceptStep(
      base(fake, async (accept) => {
        row.token = 'job-2'; // taken over before the first page is renewed
        return inner(accept);
      }),
    );

    expect(result).toEqual({ claimed: 1, finished: 0 });
    expect(fake.events).not.toContain('persist');
    expect(namesOf(fake.calls)).not.toContain('discovery_mark_model_proposal_accept_storing');
  });

  it('a paused read commits nothing and leaves the claim to expire', async () => {
    const m1 = message('m1', 'Heron update');
    const { row, proposals } = request('r1', [m1]);
    const fake = fakeAccept([row], proposals);
    const inner = readOver(scripted([page([m1])]).reader);

    const result = await acceptStep(
      base(fake, async (accept) => {
        const out = await inner(accept);
        if (out.status === 'read') out.buffer.stop = 'paused';
        return out;
      }),
    );

    expect(result).toEqual({ claimed: 1, finished: 0 });
    expect(fake.events).not.toContain('persist');
    expect(row.state).toBe('running');
  });
});

describe('what a failure carries', () => {
  it('a definer error is a code-only message: no argument, key or name in it', async () => {
    const m1 = message('m1', 'Heron update');
    const { row, proposals } = request('r1', [m1]);
    const fake = fakeAccept([row], proposals);
    const failing = {
      ...fake.db,
      rpc: async () => ({ data: null, error: { code: '57014', message: `canceling statement for ${row.deal_key}` } }),
    } as unknown as SupabaseClient;
    const error = await acceptStep(base({ db: failing }, readOver(scripted([page([m1])]).reader))).catch((e: Error) => e);
    expect((error as Error).message).toBe('discovery sync: accept discovery_claim_model_proposal_accepts failed (57014)');
    expect((error as Error).message).not.toContain('project-heron');
  });
});

describe('the read window', () => {
  it('is the day before the earliest message, in UTC', () => {
    expect(windowFromOf([{ sent_at: '2026-03-02T00:30:00Z' }, { sent_at: '2026-03-09T10:00:00Z' }])).toBe('2026-03-01');
  });

  it('is unbounded when any message has no date', () => {
    expect(windowFromOf([{ sent_at: '2026-03-02T00:30:00Z' }, { sent_at: null }])).toBeUndefined();
    expect(windowFromOf([])).toBeUndefined();
  });
});
