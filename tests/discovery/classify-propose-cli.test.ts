// @vitest-environment node
import { spawn } from 'node:child_process';
import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// classify-once --propose (#460, demo only; delete with #459). The step's locks are checked before anything is named
// or read: a closed one returns `propose_refused` with its code, records no reader pass, reads no source and opens no
// recording. --propose with --serve is a usage error, like --recount. The line prints counts only.

const recordings = vi.hoisted(() => ({ loads: 0 }));
vi.mock('@/lib/modelGateway/record', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/modelGateway/record')>();
  return {
    ...actual,
    loadRecording: (path: string) => {
      recordings.loads += 1;
      return actual.loadRecording(path);
    },
  };
});

import { READER_MODE } from '@/lib/constants/discovery';
import { DEV_TENANT_ID } from '@/lib/db/tenant';
import type { ProposalReply } from '@/lib/discovery/propose/parse';
import { PROPOSE_REPLIES, PROPOSE_STUB_REPLIES, proposeRepliesFile, proposeStepFor, proposeTransportKind } from '@/lib/discovery/propose/step';
import { routeByFirmRules } from '@/lib/discovery/route/firmRules';
import { CLASSIFY_USAGE, once, proposedLine, runOnce, summaryLine, usageError, type RunOnceOptions, type RunSummary } from '../../worker/classify';
import { memoryProposalStore } from '../helpers/memoryProposalStore';
import { proposeReplyDouble } from '../helpers/proposeReplyDouble';
import { recordingRpc } from '../helpers/readerPassRpc';
import { DEMO_LATE_DIR, demoItems } from './demoCorpus';

const TENANT = '11111111-1111-4111-8111-111111111111';
const SOURCE = '33333333-3333-4333-8333-333333333331';
const RUN = '22222222-2222-4222-8222-222222222222';
const LOCAL = { NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321', NEXT_PUBLIC_APP_ENV: 'dev' };
const REMOTE = { NEXT_PUBLIC_SUPABASE_URL: 'https://abcdefgh.supabase.co' };
const NOT_DEAL: ProposalReply = { deal_related: false, p_deal: 0.1, deal: null, phase: null, p_phase: 0 };

/** A fake service client: the proposal flag answers `flag`; every table read is recorded. */
function fakeDb(flag: { enabled: boolean } | null) {
  const froms: string[] = [];
  const recorder = recordingRpc();
  const db = {
    rpc: recorder.rpc,
    from: (table: string) => {
      froms.push(table);
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        in: () => builder,
        order: () => builder,
        maybeSingle: async () => ({ data: table === 'feature_flags' ? flag : { tenant_id: TENANT }, error: null }),
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve({
            data: table === 'content_sources' ? [{ id: SOURCE, tenant_id: TENANT, kind: 'mailbox', provider: 'microsoft', address: 'a@bank.example' }] : [],
            error: null,
          }).then(resolve),
      };
      return builder;
    },
  } as unknown as SupabaseClient;
  return { db, froms, rpc: recorder.rpc };
}

beforeEach(() => {
  recordings.loads = 0;
});

describe('a closed lock refuses the propose run before anything is read (#460)', () => {
  it.each([
    ['the flag is off', { enabled: false }, {}, 'flag_off'],
    ['the flag has no row', null, {}, 'flag_off'],
    ['a replay runs off loopback for a tenant that is not synthetic', { enabled: true }, REMOTE, 'recorded_not_synthetic'],
    ['a live call is asked for off loopback', { enabled: true }, { ...REMOTE, DISCOVERY_PROPOSE_TRANSPORT: 'gateway' }, 'not_local'],
    ['a live call is asked for a tenant that is not synthetic', { enabled: true }, { ...LOCAL, DISCOVERY_PROPOSE_TRANSPORT: 'gateway' }, 'tenant_not_synthetic'],
    ['a live call is asked for on loopback with no app env (#339 rule)', { enabled: true }, { NEXT_PUBLIC_SUPABASE_URL: LOCAL.NEXT_PUBLIC_SUPABASE_URL, DISCOVERY_PROPOSE_TRANSPORT: 'gateway' }, 'not_dev'],
  ])('when %s', async (_label, flag, env, code) => {
    const { db, froms, rpc } = fakeDb(flag);
    const summary = await runOnce({ tenantId: TENANT, db, provider: READER_MODE.FIXTURE, propose: { env } });
    expect(summary).toEqual({ tenantId: TENANT, status: 'skipped', reason: 'propose_refused', code, passes: [] });
    // The flag alone: no source is named, no pass is recorded, no registration, candidate or mail table is read.
    expect(froms).toEqual(['feature_flags']);
    expect(rpc).not.toHaveBeenCalled();
    // And no recording was opened.
    expect(recordings.loads).toBe(0);
    expect(summaryLine(summary)).toBe(`Tenant ${TENANT}: propose refused (${code}).`);
  });

  it('a live call refused by the gate builds no transport: proposeStepFor reports the code alone', () => {
    const { db } = fakeDb(null);
    expect(proposeStepFor({ tenantId: TENANT, db, flagOn: false, env: LOCAL })).toEqual({ ok: false, code: 'flag_off' });
    expect(recordings.loads).toBe(0);
  });

  it('prints a lock code only when it is code-shaped', () => {
    const odd: RunSummary = { tenantId: TENANT, status: 'skipped', reason: 'propose_refused', code: 'Not A Code: x@y', passes: [] };
    expect(summaryLine(odd)).toBe(`Tenant ${TENANT}: propose refused (unexpected).`);
  });
});

describe('an open gate builds one step per tenant that sums its pages (#460)', () => {
  it('replays on loopback, and sums the counts of every page it is handed', async () => {
    const store = memoryProposalStore();
    const transport = proposeReplyDouble(() => NOT_DEAL);
    const { db } = fakeDb(null);
    const built = proposeStepFor({ tenantId: DEV_TENANT_ID, db, flagOn: true, env: LOCAL, transport, store: store.store });
    if (!built.ok) throw new Error(built.code);
    expect(built.step.path).toBe('recorded');
    const unrouted = routeByFirmRules(demoItems(DEMO_LATE_DIR), { scope: 'unscoped' }).filter((r) => r.routes.length === 0 && r.item.kind !== 'document');
    expect(unrouted.length).toBeGreaterThan(3);
    await built.step.run(unrouted.slice(0, 2), { sourceId: SOURCE, runId: RUN });
    await built.step.run(unrouted.slice(2), { sourceId: SOURCE, runId: RUN });
    expect(built.step.tally).toMatchObject({ called: unrouted.length, notDeal: unrouted.length, deal: 0, failed: 0, costUsd: 0 });
    expect(store.rows()).toHaveLength(unrouted.length);
  });

  it('chooses the transport from DISCOVERY_PROPOSE_TRANSPORT, and the owner\'s recording over the stub', () => {
    expect(proposeTransportKind({ DISCOVERY_PROPOSE_TRANSPORT: 'gateway' })).toBe('gateway');
    expect(proposeTransportKind({})).toBe('recorded');
    expect(proposeTransportKind({ DISCOVERY_PROPOSE_TRANSPORT: 'recorded' })).toBe('recorded');
    expect(proposeRepliesFile(() => true)).toBe(PROPOSE_REPLIES);
    expect(proposeRepliesFile((path) => path === PROPOSE_STUB_REPLIES)).toBe(PROPOSE_STUB_REPLIES);
  });

  it('opens the committed stub when no transport is given and the gate replays', () => {
    const { db } = fakeDb(null);
    const built = proposeStepFor({ tenantId: DEV_TENANT_ID, db, flagOn: true, env: LOCAL, store: memoryProposalStore().store });
    expect(built.ok).toBe(true);
    expect(recordings.loads).toBe(1);
  });
});

describe('the step across pages: the firm\'s own domains and the failure stop (#460 audit A3, A4)', () => {
  const unrouted = () => routeByFirmRules(demoItems(DEMO_LATE_DIR), { scope: 'unscoped' }).filter((r) => r.routes.length === 0 && r.item.kind !== 'document');

  it('reads the firm\'s domains once per run and drops them from every row\'s parties', async () => {
    const store = memoryProposalStore({ internalDomains: ['bank.example'] });
    const reads = vi.spyOn(store.store, 'internalDomains');
    const transport = proposeReplyDouble(() => NOT_DEAL);
    const built = proposeStepFor({ tenantId: DEV_TENANT_ID, db: fakeDb(null).db, flagOn: true, env: LOCAL, transport, store: store.store });
    if (!built.ok) throw new Error(built.code);
    const entries = unrouted();
    await built.step.run(entries.slice(0, 2), { sourceId: SOURCE, runId: RUN });
    await built.step.run(entries.slice(2), { sourceId: SOURCE, runId: RUN });
    expect(reads).toHaveBeenCalledTimes(1);
    expect(transport.sent.flatMap((s) => s.input.domains)).not.toContain('bank.example');
    expect(store.rows().flatMap((r) => r.partyDomains)).not.toContain('bank.example');
  });

  it('stops after 20 failed calls in a row across pages, and the line says so', async () => {
    const transport = proposeReplyDouble(() => NOT_DEAL, { alwaysFail: true });
    const built = proposeStepFor({
      tenantId: DEV_TENANT_ID,
      db: fakeDb(null).db,
      flagOn: true,
      env: LOCAL,
      transport,
      store: memoryProposalStore().store,
      sleep: async () => {},
    });
    if (!built.ok) throw new Error(built.code);
    // Twenty-one distinct messages, over two pages.
    const msgs = Array.from({ length: 21 }, (_, i) => ({
      sourceId: SOURCE,
      providerItemId: `down-${i}`,
      item: { ...unrouted()[0].item, internetMessageId: `<down-${i}@harbourline.example>`, contentHash: `${i}`.padStart(64, 'a') },
    }));
    const entries = msgs.map((m) => ({ item: m.item, routes: [], observations: [m] }) as unknown as ReturnType<typeof unrouted>[number]);
    await built.step.run(entries.slice(0, 15), { sourceId: SOURCE, runId: RUN });
    expect(built.step.stopped).toBe(false);
    await built.step.run(entries.slice(15), { sourceId: SOURCE, runId: RUN });
    expect(built.step.stopped).toBe(true);
    expect(built.step.tally).toMatchObject({ called: 20, failed: 20 });
    expect(proposedLine({ ...built.step.tally, stopped: built.step.stopped })).toMatch(
      /failed 20, invalid 0, cost \$0\.0000\. Stopped after 20 failed calls in a row; nothing after them was asked\.$/,
    );
  });
});

describe('the team switch in runOnce: both halves, or nothing (G-01 #173)', () => {
  const FIRM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const INBOX = '66666666-6666-4666-8666-666666666666';
  const LIST = [{ tenantId: DEV_TENANT_ID, firmCompanyId: FIRM }];

  /**
   * A fake service client for a run that stops at the deal_discovery flag, after the proposal step is built and the
   * sources are named: the proposal flag is `proposeFlag`, deal_discovery has no row, one team inbox is active, and
   * every table read is recorded in order. `approvals` answers the approvals table.
   */
  function teamDb(proposeFlag: boolean, approvals: { data: unknown; error: { code: string } | null }) {
    const froms: string[] = [];
    const recorder = recordingRpc();
    const db = {
      rpc: recorder.rpc,
      from: (table: string) => {
        froms.push(table);
        let key = '';
        const builder: Record<string, unknown> = {
          select: () => builder,
          eq: (column: string, value: string) => {
            if (column === 'key') key = value;
            return builder;
          },
          is: () => builder,
          in: () => builder,
          order: () => builder,
          maybeSingle: async () => ({ data: table === 'feature_flags' ? (key === 'discovery_model_proposals_demo' && proposeFlag ? { enabled: true } : null) : { tenant_id: DEV_TENANT_ID }, error: null }),
          then: (resolve: (value: unknown) => unknown) =>
            Promise.resolve(
              table === 'discovery_tenant_approvals'
                ? approvals
                : table === 'content_sources'
                  ? {
                      data: [{ id: SOURCE, tenant_id: DEV_TENANT_ID, kind: 'mailbox', provider: 'microsoft', address: 'deals@bank.example', owner_user_id: null, team_mailbox_id: INBOX }],
                      error: null,
                    }
                  : table === 'team_mailboxes'
                    ? { data: [{ id: INBOX, firm_company_id: FIRM }], error: null }
                    : { data: [], error: null },
            ).then(resolve),
        };
        return builder;
      },
    } as unknown as SupabaseClient;
    return { db, froms };
  }

  const run = (db: SupabaseClient, over: { list?: typeof LIST } = {}) =>
    runOnce({
      tenantId: DEV_TENANT_ID,
      db,
      provider: READER_MODE.FIXTURE,
      propose: { env: LOCAL, transport: proposeReplyDouble(() => NOT_DEAL), store: memoryProposalStore().store, teamFirmList: over.list },
    });

  const LIVE = { data: [{ firm_company_id: FIRM }], error: null };

  it('with the shipped (empty) list the approvals table is never read, even with the flag on', async () => {
    const { db, froms } = teamDb(true, LIVE);
    const summary = await run(db);
    expect(summary).toMatchObject({ status: 'skipped', reason: 'flag_disabled' });
    expect(froms).toEqual(['feature_flags', 'content_sources', 'feature_flags']);
  });

  it('with a listed firm but the flag off, it stops at the gate and reads nothing else', async () => {
    const { db, froms } = teamDb(false, LIVE);
    const summary = await run(db, { list: LIST });
    expect(summary).toMatchObject({ status: 'skipped', reason: 'propose_refused', code: 'flag_off' });
    expect(froms).toEqual(['feature_flags']);
  });

  it('with a listed firm that holds a live row, the team inbox is looked up for its firm', async () => {
    const { db, froms } = teamDb(true, LIVE);
    const summary = await run(db, { list: LIST });
    expect(summary).toMatchObject({ status: 'skipped', reason: 'flag_disabled' });
    expect(froms).toEqual(['feature_flags', 'discovery_tenant_approvals', 'content_sources', 'team_mailboxes', 'feature_flags']);
  });

  it.each([
    ['the approvals read fails', { data: null, error: { code: '42501' } }],
    ['the table answers nothing usable', { data: 'nope', error: null }],
    ['the firm has no row', { data: [], error: null }],
    ['only another firm has a row', { data: [{ firm_company_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }], error: null }],
  ])('a listed firm is off when %s: no firm is looked up, so the inbox stays out of the step', async (_label, approvals) => {
    const { db, froms } = teamDb(true, approvals);
    const summary = await run(db, { list: LIST });
    expect(summary).toMatchObject({ status: 'skipped', reason: 'flag_disabled' });
    expect(froms).toEqual(['feature_flags', 'discovery_tenant_approvals', 'content_sources', 'feature_flags']);
  });

  // Review F8: the step keeps only the firms the reviewed list names, whatever its caller hands it.
  it('a firm with an approval row that the reviewed list does not name opens nothing, even when the caller passes it', async () => {
    const unrouted = routeByFirmRules(demoItems(DEMO_LATE_DIR), { scope: 'unscoped' }).filter((r) => r.routes.length === 0 && r.item.kind !== 'document');
    const m = memoryProposalStore({ teamSources: { [SOURCE]: FIRM }, approvedFirms: [FIRM] });
    const transport = proposeReplyDouble(() => NOT_DEAL);
    const built = proposeStepFor({ tenantId: DEV_TENANT_ID, db: fakeDb(null).db, flagOn: true, env: LOCAL, transport, store: m.store, teamFirms: [FIRM] });
    if (!built.ok) throw new Error(built.code);
    expect([...built.step.teamFirms]).toEqual([]);
    await built.step.run(unrouted.slice(0, 2), { sourceId: SOURCE, runId: RUN });
    expect(transport.sent).toEqual([]);
    expect(m.passes()).toEqual([]);
    expect(built.step.sources.refused).toBe(1);

    // The same firm named in the (test) list as well: the pass opens and the mail is asked.
    const m2 = memoryProposalStore({ teamSources: { [SOURCE]: FIRM }, approvedFirms: [FIRM] });
    const t2 = proposeReplyDouble(() => NOT_DEAL);
    const listed = proposeStepFor({
      tenantId: DEV_TENANT_ID, db: fakeDb(null).db, flagOn: true, env: LOCAL, transport: t2, store: m2.store, teamFirms: [FIRM], teamFirmList: LIST,
    });
    if (!listed.ok) throw new Error(listed.code);
    expect([...listed.step.teamFirms]).toEqual([FIRM]);
    await listed.step.run(unrouted.slice(0, 2), { sourceId: SOURCE, runId: RUN });
    expect(t2.sent).toHaveLength(2);
    expect(m2.passes()).toMatchObject([{ sourceId: SOURCE, open: true }]);
  });

  // Review F5: a pass a dead run left open is swept before any source is read, whatever the switch says now.
  it('sweeps the tenant\'s lapsed passes once, before any source is read, with the shipped empty list', async () => {
    const m = memoryProposalStore({
      passes: [{ tenantId: DEV_TENANT_ID, sourceId: SOURCE, runId: 'dead-run', firmId: FIRM, path: 'recorded', leaseUntil: Date.now() - 60_000, open: true, outcome: null, counts: null }],
    });
    const { db } = teamDb(true, LIVE);
    await runOnce({ tenantId: DEV_TENANT_ID, db, provider: READER_MODE.FIXTURE, propose: { env: LOCAL, transport: proposeReplyDouble(() => NOT_DEAL), store: m.store } });
    expect(m.calls.closeLapsedPasses).toBe(1);
    expect(m.passes()).toMatchObject([{ runId: 'dead-run', open: false, outcome: 'unclosed' }]);
  });

  it('a sweep that fails does not stop the run', async () => {
    const m = memoryProposalStore();
    m.store.closeLapsedPasses = async () => {
      throw new Error('close lapsed proposal passes failed: 57014');
    };
    const { db } = teamDb(true, LIVE);
    const summary = await runOnce({ tenantId: DEV_TENANT_ID, db, provider: READER_MODE.FIXTURE, propose: { env: LOCAL, transport: proposeReplyDouble(() => NOT_DEAL), store: m.store } });
    expect(summary).toMatchObject({ status: 'skipped', reason: 'flag_disabled' });
  });

  it('prints the skipped and refused source counts as numbers after the cost', () => {
    const tally = { called: 1, deal: 0, newNames: 0, notDeal: 1, failed: 0, invalid: 0, skippedNotSynthetic: 0, costUsd: 0 };
    expect(proposedLine({ ...tally, sourcesSkipped: 2, sourcesRefused: 1 })).toBe(
      'Proposed: called 1, deal 0, new names 0, not deal 1, failed 0, invalid 0, cost $0.0000, sources skipped 2, sources refused 1.',
    );
    // Without the counts, the line is as it was.
    expect(proposedLine(tally)).toBe('Proposed: called 1, deal 0, new names 0, not deal 1, failed 0, invalid 0, cost $0.0000.');
  });
});

describe('the Proposed counts on the line (#460)', () => {
  const tally = { called: 16, deal: 4, newNames: 1, notDeal: 12, failed: 0, invalid: 0, skippedNotSynthetic: 0, costUsd: 0.004571 };

  it('are integers and a cost, appended after the run id', () => {
    expect(proposedLine(tally)).toBe('Proposed: called 16, deal 4, new names 1, not deal 12, failed 0, invalid 0, cost $0.0046.');
    expect(proposedLine({ ...tally, stopped: true, stoppedBy: 'zdr_unavailable' })).toMatch(
      /cost \$0\.0046\. Stopped: the AI Gateway refused zero data retention, so AI is off; nothing after it was asked\.$/,
    );
    expect(proposedLine({ ...tally, failed: 1, stopped: true, stoppedBy: 'ledger' })).toMatch(
      /failed 1, invalid 0, cost \$0\.0046\. Stopped: an AI usage row could not be written; nothing after it was asked\. The cost is recorded spend only: the attempt whose row was refused is not in it\.$/,
    );
    const summary: RunSummary = {
      tenantId: TENANT,
      status: 'ok',
      runId: RUN,
      sources: 1,
      itemsRead: 20,
      itemsStored: 4,
      fetched: 20,
      excluded: 0,
      screening: { screened: 20, flagged: 0 },
      candidates: [{ clusterKey: 'codename:kestrel', candidateId: '44444444-4444-4444-8444-444444444441', created: false }],
      refused: [],
      skipped: [],
      allowlist: 'in_sync',
      providers: [{ provider: 'microsoft', allowlist: 'in_sync', sources: 1, refused: [] }],
      passes: [{ sourceId: SOURCE, passId: '55555555-5555-4555-8555-555555555555' }],
      routing: { read: 20, routed: 4, unrouted: 16, skipped: 0, collisions: 0, codenames: 1, fullRead: true, scopeBlocked: 0 },
      proposed: tally,
    };
    const line = summaryLine(summary);
    expect(line).toMatch(new RegExp(`Run ${RUN}\\. Proposed: called 16, deal 4, new names 1, not deal 12, failed 0, invalid 0, cost \\$0\\.0046\\.$`));
    expect(line).not.toMatch(/kestrel|@/i);
    // Without a propose run, the line is as it was.
    expect(summaryLine({ ...summary, proposed: undefined })).toMatch(new RegExp(`Run ${RUN}\\.$`));
  });
});

describe('classify-once after a ledger stop (#645)', () => {
  const OTHER = '11111111-1111-4111-8111-111111111112';
  /** Every registration table lists both tenants. */
  const registrations = {
    from: () => {
      const builder = { select: () => builder, eq: async () => ({ data: [{ tenant_id: TENANT }, { tenant_id: OTHER }], error: null }) };
      return builder;
    },
  } as unknown as SupabaseClient;
  const ran = (tenantId: string, stoppedBy?: 'ledger'): RunSummary => ({
    tenantId,
    status: 'ok',
    runId: RUN,
    sources: 1,
    itemsRead: 1,
    itemsStored: 0,
    fetched: 1,
    excluded: 0,
    screening: { screened: 1, flagged: 0 },
    candidates: [],
    refused: [],
    skipped: [],
    allowlist: 'in_sync',
    providers: [],
    passes: [],
    routing: { read: 1, routed: 0, unrouted: 1, skipped: 0, collisions: 0, codenames: 0, fullRead: true, scopeBlocked: 0 },
    proposed: { called: 1, deal: 0, newNames: 0, notDeal: 0, failed: 1, invalid: 0, skippedNotSynthetic: 0, costUsd: 0, stopped: !!stoppedBy, stoppedBy },
  });

  it.each([
    ['a ledger stop exits 1 and asks no later tenant', 'ledger' as const, [TENANT], 1],
    ['without a stop, every tenant runs and the exit code is untouched', undefined, [TENANT, OTHER], undefined],
  ])('%s', async (_label, stoppedBy, tenants, exitCode) => {
    const asked: string[] = [];
    const run = async (o: RunOnceOptions) => {
      asked.push(o.tenantId);
      return ran(o.tenantId, stoppedBy);
    };
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const before = process.exitCode;
    process.exitCode = undefined;
    try {
      await once(['--propose'], { db: registrations, runOnce: run });
      expect(process.exitCode).toBe(exitCode);
    } finally {
      process.exitCode = before;
      log.mockRestore();
    }
    expect(asked).toEqual(tenants);
  });
});

describe('--propose is a usage error with --serve (#460)', () => {
  it('names the combination by a fixed code', () => {
    expect(usageError(['--serve', '--propose'])).toBe(CLASSIFY_USAGE.PROPOSE_WITH_SERVE);
    expect(usageError(['--propose', '--tenant', TENANT])).toBeNull();
    expect(usageError(['--propose', '--recount'])).toBeNull();
  });

  it('the CLI exits 2 with one fatal line carrying the code, before it builds a client', async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'worker/classify.ts', '--serve', '--propose'], {
      cwd: process.cwd(),
      // A minimal environment: no database, so a client built by mistake would fail differently.
      env: { NODE_ENV: 'test', PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    expect(code, err).toBe(2);
    expect(out.trim().split('\n').map((line) => JSON.parse(line))).toEqual([{ evt: 'fatal', reason: 'propose_with_serve' }]);
    expect(err).toBe('');
  }, 60_000);
});
