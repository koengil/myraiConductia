// @vitest-environment node
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The AWS worker's production Gmail path (#344 with #263): the queued sync handler of the classify
// service in live mode (DISCOVERY_READER_MODE=live on the task), with the real guard wrapper, the real
// live Gmail factory and the real sync loop. Only the database and the network are fakes. A tenant with
// no stored exclusion policy, or a policy that reaches the reader at version 0 (the fixture-only empty
// policy; the table itself refuses a stored version below 1), must be refused before the mailbox guard is
// asked and before any request leaves the task: no token mint, no Gmail call, nothing. The source's
// Last error and the job line carry the fixed code only.

// The guard's own service client (src/lib/mailboxAccess/guard.ts) is the fake below.
const admin = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseAdminClient: () => admin.client,
  createSupabaseServerClient: async () => {
    throw new Error('no session client in the worker tests');
  },
}));

import { READER_MODE } from '@/lib/constants/discovery';
import type { ProviderAllowlistMirror } from '@/lib/mailboxAccess';
import { createWorkerHandlers } from '../../worker/classify';
import { runJob } from '../../worker/jobLog';
import { SYNC_ERROR } from '../../worker/sync';

const TENANT = '11111111-1111-4111-8111-111111111111';
const SOURCE_ID = '33333333-3333-4333-8333-333333333333';
const PERSONA = 'probe-persona@bank.example';

type Policy = { version: number; rules: unknown[] };

/** A service client over fixed rows: the reads the sync handler makes, and the writes and RPCs it records. */
function fakeDb(policies: Policy[]) {
  const updates: Array<{ table: string; values: Record<string, unknown> }> = [];
  const rpcs: string[] = [];
  const tables: Record<string, unknown[]> = {
    feature_flags: [{ key: 'deal_discovery', enabled: true }],
    google_reader_registrations: [
      {
        tenant_id: TENANT,
        workspace_domain: 'bank.example',
        service_account_email: 'dwd-reader@proj-1.iam.gserviceaccount.com',
        client_id: '123456789012345678',
        directory_service_account_email: 'dir-reader@proj-1.iam.gserviceaccount.com',
        allowlist_group: 'conductia-ingest@bank.example',
        firm_company_id: null,
        status: 'active',
      },
    ],
    graph_reader_registrations: [],
    content_sources: [
      {
        id: SOURCE_ID,
        tenant_id: TENANT,
        kind: 'mailbox',
        provider: 'google',
        address: PERSONA,
        owner_user_id: '22222222-2222-4222-8222-222222222222',
        delta_checkpoint: null,
        backfill_completed_at: null,
        backfill_started_at: null,
        history_expiry_streak: 0,
        last_synced_at: null,
        status: 'active',
      },
    ],
    allowed_mailboxes: [{ tenant_id: TENANT, provider: 'google', address: PERSONA, user_id: '22222222-2222-4222-8222-222222222222' }],
    discovery_exclusion_policies: policies,
    discovery_thread_taints: [],
  };
  const from = (table: string) => {
    const rows = tables[table] ?? [];
    const builder: Record<string, unknown> = {};
    for (const method of ['eq', 'in', 'not', 'is', 'order', 'limit', 'ilike']) builder[method] = () => builder;
    // As PostgREST answers: a range returns that slice, and a count only when the select asks for one.
    let slice: [number, number] | null = null;
    let counted = false;
    builder.select = (_columns?: string, options?: { count?: string }) => ((counted = Boolean(options?.count)), builder);
    builder.range = (a: number, b: number) => ((slice = [a, b]), builder);
    builder.maybeSingle = async () => ({ data: rows[0] ?? null, error: null });
    builder.single = async () => ({ data: rows[0] ?? null, error: null });
    builder.update = (values: Record<string, unknown>) => {
      updates.push({ table, values });
      const chain: Record<string, unknown> = {};
      for (const method of ['eq', 'select', 'is']) chain[method] = () => chain;
      chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [{ id: SOURCE_ID }], error: null }).then(resolve);
      return chain;
    };
    builder.then = (resolve: (value: unknown) => unknown) =>
      Promise.resolve({
        data: slice ? rows.slice(slice[0], slice[1] + 1) : rows,
        error: null,
        count: counted ? rows.length : null,
      }).then(resolve);
    return builder;
  };
  // Awaitable with .abortSignal(), as supabase-js returns it: the worker's reader pass record (#370) bounds its sends.
  const rpc = (name: string) => {
    rpcs.push(name);
    const answer = Promise.resolve({ data: null, error: null });
    return Object.assign(answer, { abortSignal: () => answer });
  };
  return { db: { from, rpc } as unknown as SupabaseClient, updates, rpcs };
}

/** The allowlist group holds the persona; the live directory mirror is out of scope here. */
const group: ProviderAllowlistMirror = { listMembers: async () => [PERSONA] };

let requests: string[];
let stdout: string[];
beforeEach(() => {
  requests = [];
  stdout = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return new Response('{}', { status: 500 });
    }),
  );
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => (stdout.push(String(chunk)), true));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  admin.client = null;
});

function liveHandlers(policies: Policy[]) {
  const fake = fakeDb(policies);
  admin.client = fake.db;
  const handlers = createWorkerHandlers({ db: fake.db, boss: { send: vi.fn(async () => 'job') }, provider: READER_MODE.LIVE, mirror: group });
  return { ...fake, handlers };
}

describe('the AWS worker never reads Gmail without the stored exclusion policy (#344, #263)', () => {
  it('a tenant with no stored policy: refused before the guard and before any request, Last error and job line a fixed code', async () => {
    const { handlers, updates, rpcs } = liveHandlers([]);
    const run = runJob('sync', { tenant: TENANT, source: SOURCE_ID }, () => handlers.sync({ tenantId: TENANT, sourceId: SOURCE_ID }));
    await expect(run).rejects.toMatchObject({ name: 'WorkerJobError', message: SYNC_ERROR.NO_EXCLUSION_POLICY });

    expect(requests).toEqual([]);
    expect(rpcs).not.toContain('mailbox_guard_check');
    expect(updates).toContainEqual({ table: 'content_sources', values: expect.objectContaining({ last_error: SYNC_ERROR.NO_EXCLUSION_POLICY }) });
    const lines = stdout.join('').trim().split('\n').map((line) => JSON.parse(line));
    expect(lines).toEqual([{ evt: 'sync', tenant: TENANT, source: SOURCE_ID, status: 'failed', reason: SYNC_ERROR.NO_EXCLUSION_POLICY }]);
  });

  it('a policy that reaches the live reader at version 0: refused when the reader is built, before the guard and before any request', async () => {
    const { handlers, rpcs } = liveHandlers([{ version: 0, rules: [] }]);
    await expect(handlers.sync({ tenantId: TENANT, sourceId: SOURCE_ID })).rejects.toMatchObject({ name: 'NoExclusionPolicyError' });

    expect(requests).toEqual([]);
    expect(rpcs).not.toContain('mailbox_guard_check');
  });

  it('with a stored policy the same path goes on to the guard: the refusals above are the policy, not a broken fake', async () => {
    const { handlers, rpcs } = liveHandlers([{ version: 1, rules: [] }]);
    // The fake guard answers nothing usable and no Google credential exists here, so the read fails later; what
    // matters is that it got past the policy check to the mailbox guard.
    await handlers.sync({ tenantId: TENANT, sourceId: SOURCE_ID }).catch(() => undefined);
    expect(rpcs).toContain('mailbox_guard_check');
  });
});
