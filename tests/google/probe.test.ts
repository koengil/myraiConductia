// @vitest-environment node
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { GMAIL_PROBE_RAW_FIELDS } from '@/lib/constants/googleReader';
import { GoogleHttpError } from '@/lib/google/reader/http';
import type { ProviderAllowlistMirror } from '@/lib/mailboxAccess';

import {
  formatProbeLine,
  INCONCLUSIVE_ALLOWED,
  probeErrorLine,
  probeFailed,
  ProbeCodeError,
  REQUIRED_CHECKS,
  runProbe,
  type ProbeDeps,
  type ProbeResult,
} from '../../scripts/google/lib/probe';
import { buildProbeGuard, PROBE_GUARD_CALLER } from '../../scripts/google/lib/probeGuard';
import { probeMain } from '../../scripts/google/probe-connections';
import { DIR_SA, DIRECTORY_CONFIG_TOKEN, DRIVE_SA, DWD, namedIn, world, type WorldRecord } from './probeWorld';

// The guard's own service client (src/lib/mailboxAccess/guard.ts) answers from the fake state below.
const admin = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseAdminClient: () => admin.client,
  createSupabaseServerClient: async () => {
    throw new Error('no session client in the probe tests');
  },
}));

const TENANT = '11111111-1111-4111-8111-111111111111';
const DOMAIN = 'bank.example';
const GROUP = 'conductia-ingest@bank.example';
const MAILBOX = 'storm.duncan@bank.example';
const OUT_OF_SCOPE = 'probe-out-of-scope@bank.example';
const PERSONA_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_ID = '33333333-3333-4333-8333-333333333333';

let dir: string;
let credentials: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'probe-'));
  credentials = join(dir, 'worker-credentials.json');
  writeFileSync(credentials, JSON.stringify({ type: 'external_account' }));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const REGISTRATION = {
  tenantId: TENANT,
  workspaceDomain: DOMAIN,
  serviceAccountEmail: DWD,
  clientId: '123456789012345678',
  directoryServiceAccountEmail: DIR_SA,
  allowlistGroup: GROUP,
};

/** The guard wiring of a consented persona that the group holds. */
const admits = (refusalFor: (address: string) => string | null = (a) => (a === MAILBOX ? null : 'no_source')) => ({
  guardFor: async (address: string) => refusalFor(address),
  group: async () => ({ count: 2, providerCheck: () => null }),
  registeredOutOfScope: async () => true,
});

function deps(fetchImpl: typeof fetch, extra: Partial<ProbeDeps> = {}): ProbeDeps {
  return {
    env: { GOOGLE_APPLICATION_CREDENTIALS: credentials },
    callerToken: async () => 'caller-token',
    fetchImpl,
    registration: REGISTRATION,
    mailbox: MAILBOX,
    secretsDir: join(dir, 'no-secrets'),
    driveId: 'drive-1',
    driveProbeServiceAccountEmail: DRIVE_SA,
    ...extra,
  };
}

const statusOf = (results: ProbeResult[], id: string) => results.find((r) => r.id === id)?.status;
const detailOf = (results: ProbeResult[], id: string) => results.find((r) => r.id === id)?.detail;
const PERSONA_IDS = ['P02', 'P03', 'P04', 'P05', 'P06', 'P07', 'P09'];
const RAW_TEST_MESSAGE = '18c2f3a4b5d6e7f8';
const CANARY_ID = 'canary-message-id';

/** Nothing in the run named the address: no Gmail request, no signJwt payload, no issued token. */
function expectUnnamed(w: WorldRecord, address: string) {
  expect(namedIn(w, address)).toEqual({ gmailRequests: [], signedFor: [], issuedFor: [] });
}

describe('runProbe', () => {
  it('passes a correctly delegated tenant, guard first, and records what it cannot check', async () => {
    const w = world();
    const results = await runProbe(
      deps(w.fetchImpl, { ...admits(), outOfScope: { address: OUT_OF_SCOPE }, rawTestMessageId: RAW_TEST_MESSAGE }),
    );
    expect(results.map((r) => r.id)).toEqual(['P01', 'P02', 'P03', 'P04', 'P05', 'P06', 'P07', 'P08', 'P09', 'P10', 'P11', 'P12', 'P13', 'P14']);
    for (const id of ['P01', 'P02', 'P03', 'P04', 'P05', 'P06', 'P07', 'P08', 'P09', 'P12', 'P13', 'P14']) {
      expect(statusOf(results, id), id).toBe('PASS');
    }
    expect(statusOf(results, 'P10')).toBe('UNAVAILABLE'); // never PASS by default
    expect(statusOf(results, 'P11')).toBe('MANUAL');
    expect(detailOf(results, 'P08')).toBe('200, 2 members'); // the group read P14 used
    expect(probeFailed(results)).toBe(false);
    expect(REQUIRED_CHECKS).toContain('P14');
  });

  describe('P05 reads only the designated test message (never the first in the inbox)', () => {
    const rawReads = (w: WorldRecord) => w.requests.filter((r) => r.url.includes('format=raw')).map((r) => r.url);

    it('with no designated message: SKIPPED, no raw request and no message listed', async () => {
      const w = world();
      const results = await runProbe(deps(w.fetchImpl, admits()));
      expect(statusOf(results, 'P04')).toBe('PASS');
      expect(statusOf(results, 'P05')).toBe('SKIPPED');
      expect(detailOf(results, 'P05')).toBe('no designated test message');
      expect(rawReads(w)).toEqual([]);
      expect(w.requests.some((r) => r.url.includes('/messages'))).toBe(false);
    });

    it('with one: the raw request names that id and no other', async () => {
      const w = world();
      const results = await runProbe(deps(w.fetchImpl, { ...admits(), rawTestMessageId: RAW_TEST_MESSAGE.toUpperCase() }));
      expect(statusOf(results, 'P05')).toBe('PASS');
      expect(rawReads(w)).toEqual([
        `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(MAILBOX)}/messages/${RAW_TEST_MESSAGE}?format=raw&fields=${GMAIL_PROBE_RAW_FIELDS}`,
      ]);
    });

    it.each(['../profile', 'm1?format=full', `${CANARY_ID}@x`, ''.padEnd(40, 'a')])(
      'refuses a malformed designated id (%s) before any Google call',
      async (id) => {
        const w = world();
        await expect(runProbe(deps(w.fetchImpl, { ...admits(), rawTestMessageId: id }))).rejects.toMatchObject({
          code: 'arg_malformed_message_id',
          message: 'arg_malformed_message_id',
        });
        expect(w.requests).toEqual([]);
      },
    );
  });

  describe('the exit rule: every required check PASS, inconclusive fails, P09 and P12 UNAVAILABLE excepted', () => {
    const passing = (): ProbeResult[] => REQUIRED_CHECKS.map((id) => ({ id, status: 'PASS', label: id }));
    const withStatus = (id: string, status: ProbeResult['status']) =>
      passing().map((r) => (r.id === id ? { ...r, status } : r));

    it('passes when every required check is PASS', () => {
      expect(probeFailed(passing())).toBe(false);
    });

    it.each([
      ['P13', 'UNAVAILABLE'],
      ['P13', 'PENDING'],
      ['P14', 'PENDING'],
      ['P14', 'SKIPPED'],
      ['P02', 'SKIPPED'],
      ['P09', 'SKIPPED'],
      ['P09', 'FAIL'],
      ['P12', 'FAIL'],
      ['P01', 'FAIL'],
    ] as const)('%s %s fails the run', (id, status) => {
      expect(probeFailed(withStatus(id, status))).toBe(true);
    });

    it.each(['P09', 'P12'])('%s UNAVAILABLE is the documented exception', (id) => {
      expect(INCONCLUSIVE_ALLOWED).toEqual({ P09: 'UNAVAILABLE', P12: 'UNAVAILABLE' });
      expect(probeFailed(withStatus(id, 'UNAVAILABLE'))).toBe(false);
    });

    it('a missing required check fails the run', () => {
      expect(probeFailed(passing().filter((r) => r.id !== 'P13'))).toBe(true);
    });
  });

  it('asks the guard before any request that names the persona', async () => {
    const w = world();
    let requestsWhenAsked = -1;
    await runProbe(
      deps(w.fetchImpl, {
        ...admits(),
        guardFor: async () => {
          requestsWhenAsked = w.requests.length;
          return null;
        },
      }),
    );
    expect(requestsWhenAsked).toBe(0);
    expect(namedIn(w, MAILBOX).signedFor.length).toBeGreaterThan(0);
  });

  it('fails P07 when a gmail.modify token is issued (over-grant)', async () => {
    const results = await runProbe(deps(world({ modifyIssued: true }).fetchImpl, admits()));
    expect(statusOf(results, 'P07')).toBe('FAIL');
    expect(probeFailed(results)).toBe(true);
  });

  it('fails P12 when the Drive probe identity can write', async () => {
    const results = await runProbe(deps(world({ driveWritable: true }).fetchImpl, admits()));
    expect(statusOf(results, 'P12')).toBe('FAIL');
  });

  it('fails P01 for a key file and skips the checks that need a caller token, the guard included', async () => {
    const keyFile = join(dir, 'sa.json');
    writeFileSync(keyFile, JSON.stringify({ type: 'service_' + 'account' }));
    const results = await runProbe(deps(world().fetchImpl, { ...admits(), env: { GOOGLE_APPLICATION_CREDENTIALS: keyFile } }));
    expect(statusOf(results, 'P01')).toBe('FAIL');
    expect(statusOf(results, 'P02')).toBe('SKIPPED');
    expect(statusOf(results, 'P14')).toBe('SKIPPED');
    expect(probeFailed(results)).toBe(true);
  });

  it('without the guard (a laptop run with no --guard-db), P14 is PENDING and nothing names the persona', async () => {
    const w = world();
    const results = await runProbe(deps(w.fetchImpl));
    expect(statusOf(results, 'P14')).toBe('PENDING');
    for (const id of PERSONA_IDS) expect(statusOf(results, id), id).toBe('SKIPPED');
    expect(statusOf(results, 'P08')).toBe('PASS'); // listed by the directory identity itself
    expectUnnamed(w, MAILBOX);
    expect(probeFailed(results)).toBe(true); // P14 and P13 inconclusive
  });

  it('refuses to run without the guard in production, before any Google call', async () => {
    const w = world();
    await expect(
      runProbe(deps(w.fetchImpl, { env: { GOOGLE_APPLICATION_CREDENTIALS: credentials, NEXT_PUBLIC_APP_ENV: 'prod' } })),
    ).rejects.toMatchObject({ code: 'arg_guard_required' });
    expect(w.requests).toEqual([]);
  });

  describe('P14: the guard refuses the persona, so nothing names it (#262, round 2 blocker 1)', () => {
    it.each([
      ['owner_mismatch', async () => 'owner_mismatch'],
      ['no_consent', async () => 'no_consent'],
      ['not_in_provider_group', async () => 'not_in_provider_group'],
      [
        'the guard unavailable',
        async () => {
          throw new ProbeCodeError('guard_unavailable');
        },
      ],
    ])('%s: P14 FAIL, zero Gmail requests and no signJwt naming the persona in any check', async (_name, guard) => {
      const w = world();
      const results = await runProbe(
        deps(w.fetchImpl, {
          ...admits(),
          guardFor: async (address) => (address === MAILBOX ? guard() : 'no_source'),
          outOfScope: { address: OUT_OF_SCOPE },
        }),
      );
      expect(statusOf(results, 'P14')).toBe('FAIL');
      for (const id of PERSONA_IDS) {
        expect(statusOf(results, id), id).toBe('SKIPPED');
        expect(detailOf(results, id), id).toBe('the guard did not admit the persona mailbox');
      }
      expectUnnamed(w, MAILBOX);
      // Checks that do not name the persona still run.
      expect(statusOf(results, 'P08')).toBe('PASS');
      expect(statusOf(results, 'P13')).toBe('PASS');
      expect(probeFailed(results)).toBe(true);
    });

    it('reports the refusal code, never a message', async () => {
      const results = await runProbe(deps(world().fetchImpl, { ...admits(() => 'owner_mismatch') }));
      expect(detailOf(results, 'P14')).toBe('refused owner_mismatch');
    });
  });

  describe('P13: a token-only check on the registered out-of-scope account', () => {
    const run = (w: WorldRecord, refusal: string | null | (() => Promise<string | null>)) =>
      runProbe(
        deps(w.fetchImpl, {
          ...admits(),
          guardFor: async (address) =>
            address === MAILBOX ? null : typeof refusal === 'function' ? refusal() : refusal,
          outOfScope: { address: OUT_OF_SCOPE },
        }),
      );

    it.each(['no_source', 'no_consent', 'no_invite', 'seat_inactive'])(
      'refused %s: one token minted and discarded, no Gmail request names it, PASS',
      async (refusal) => {
        const w = world();
        const results = await run(w, refusal);
        expect(statusOf(results, 'P13')).toBe('PASS');
        const named = namedIn(w, OUT_OF_SCOPE);
        expect(named.gmailRequests).toEqual([]);
        expect(named.signedFor).toHaveLength(1);
        expect(named.signedFor[0].scope).toBe('https://www.googleapis.com/auth/gmail.readonly');
        expect(named.issuedFor).toHaveLength(1);
        expect(probeFailed(results)).toBe(false);
      },
    );

    it.each(['owner_mismatch', 'not_in_provider_group', 'source_paused', 'registration_inactive', 'external', 'domain'])(
      'refused %s: inconclusive (UNAVAILABLE), and no Google call names it',
      async (refusal) => {
        const w = world();
        const results = await run(w, refusal);
        expect(statusOf(results, 'P13')).toBe('UNAVAILABLE');
        expect(detailOf(results, 'P13')).toContain('inconclusive');
        expectUnnamed(w, OUT_OF_SCOPE);
      },
    );

    it('admitted: FAIL, the probe fails, and no Google call names it', async () => {
      const w = world();
      const results = await run(w, null);
      expect(statusOf(results, 'P13')).toBe('FAIL');
      expect(probeFailed(results)).toBe(true);
      expectUnnamed(w, OUT_OF_SCOPE);
    });

    it('delegation does not cover it: UNAVAILABLE, not PASS', async () => {
      const w = world({ uncovered: OUT_OF_SCOPE });
      const results = await run(w, 'no_source');
      expect(statusOf(results, 'P13')).toBe('UNAVAILABLE');
      expect(namedIn(w, OUT_OF_SCOPE).gmailRequests).toEqual([]);
    });

    it('the guard cannot be asked: FAIL, and no Google call names it', async () => {
      const w = world();
      const results = await run(w, async () => {
        throw new ProbeCodeError('guard_unavailable');
      });
      expect(statusOf(results, 'P13')).toBe('FAIL');
      expect(detailOf(results, 'P13')).toBe('the guard could not be asked: guard_unavailable');
      expectUnnamed(w, OUT_OF_SCOPE);
    });

    it.each([
      ['a Conductia user or invitee, or allowlisted', { registeredOutOfScope: async () => false }, OUT_OF_SCOPE],
      ['not checked at all', { registeredOutOfScope: undefined }, OUT_OF_SCOPE],
      ['the persona itself', {}, MAILBOX],
      ['outside the domain', {}, 'probe-out-of-scope@elsewhere.example'],
    ])('refuses an out-of-scope address that is %s before any Google call', async (_name, extra, address) => {
      const w = world();
      await expect(
        runProbe(deps(w.fetchImpl, { ...admits(), ...extra, outOfScope: { address } })),
      ).rejects.toMatchObject({ code: 'out_of_scope_not_registered' });
      expect(w.requests).toEqual([]);
    });

    it('refuses with a fixed code when the registration check cannot be asked', async () => {
      const w = world();
      await expect(
        runProbe(
          deps(w.fetchImpl, {
            ...admits(),
            registeredOutOfScope: async () => {
              throw new Error('canary lookup message');
            },
            outOfScope: { address: OUT_OF_SCOPE },
          }),
        ),
      ).rejects.toMatchObject({ code: 'out_of_scope_lookup_failed', message: 'out_of_scope_lookup_failed' });
      expect(w.requests).toEqual([]);
    });
  });

  describe('P09 passes only on Google refusing the directory identity', () => {
    it.each([
      ['unauthorized_client', {}, 'PASS'],
      ['a delegated token issued', { directoryDelegated: true }, 'FAIL'],
      ['an IAM denial on signJwt', { directorySignDenied: true }, 'UNAVAILABLE'],
      [
        'an IAM denial on signJwt, as the IAM Credentials API words it',
        { directorySignFailure: { status: 403, body: { error: { code: 403, status: 'PERMISSION_DENIED' } } } },
        'UNAVAILABLE',
      ],
      ['a network error', { directoryExchangeNetworkError: true }, 'FAIL'],
      ['signJwt throttled (429)', { directorySignFailure: { status: 429, body: { error: { status: 'RESOURCE_EXHAUSTED' } } } }, 'FAIL'],
      [
        'signJwt rate-limited (403 rateLimitExceeded)',
        { directorySignFailure: { status: 403, body: { error: { errors: [{ reason: 'rateLimitExceeded' }] } } } },
        'FAIL',
      ],
      ['signJwt a 5xx', { directorySignFailure: { status: 503, body: { error: { status: 'UNAVAILABLE' } } } }, 'FAIL'],
      ['signJwt a 403 with another reason', { directorySignFailure: { status: 403, body: { error: { status: 'FAILED_PRECONDITION' } } } }, 'FAIL'],
      ['signJwt a 404', { directorySignFailure: { status: 404, body: { error: { status: 'NOT_FOUND' } } } }, 'FAIL'],
      ['signJwt fails at the network', { directorySignFailure: 'network' }, 'FAIL'],
    ] as const)('%s: %s', async (_name, opts, expected) => {
      const results = await runProbe(deps(world(opts).fetchImpl, { ...admits(), outOfScope: { address: OUT_OF_SCOPE } }));
      expect(statusOf(results, 'P09')).toBe(expected);
      // Only the expected IAM denial is the exit exception; everything else fails the run.
      expect(probeFailed(results)).toBe(expected !== 'PASS' && expected !== 'UNAVAILABLE');
    });
  });

  describe('P08 and P10 use the directory credential (design R5)', () => {
    it('self mode: generateAccessToken denied, the directory config token lists the group, PASS', async () => {
      const w = world({ generateAccessTokenDenied: true });
      const { group: _group, ...guard } = admits();
      void _group;
      const results = await runProbe(deps(w.fetchImpl, { ...guard, directoryToken: async () => DIRECTORY_CONFIG_TOKEN }));
      expect(statusOf(results, 'P08')).toBe('PASS');
      const groupCalls = w.requests.filter((r) => r.url.includes('/groups/'));
      expect(groupCalls.map((r) => r.auth)).toEqual([`Bearer ${DIRECTORY_CONFIG_TOKEN}`]);
      // No generateAccessToken on the directory SA (P12's drive probe SA has its own).
      expect(w.requests.some((r) => r.url.includes(`${encodeURIComponent(DIR_SA)}:generateAccessToken`))).toBe(false);
      // P10 asks Reports with the same credential.
      expect(w.requests.find((r) => r.url.includes('/reports/v1/'))?.auth).toBe(`Bearer ${DIRECTORY_CONFIG_TOKEN}`);
    });

    it('without a directory credential, generateAccessToken denied fails P08', async () => {
      const { group: _group, ...guard } = admits();
      void _group;
      const results = await runProbe(deps(world({ generateAccessTokenDenied: true }).fetchImpl, guard));
      expect(statusOf(results, 'P08')).toBe('FAIL');
      expect(detailOf(results, 'P08')).toBe('403 forbidden');
    });

    it('with the guard wired, P08 reports the group read failure and P14 fails closed', async () => {
      const w = world();
      const results = await runProbe(
        deps(w.fetchImpl, {
          ...admits(),
          group: async () => {
            throw new ProbeCodeError('group_unavailable', new GoogleHttpError(403, 'forbidden', 1));
          },
          guardFor: async () => {
            throw new ProbeCodeError('group_unavailable');
          },
        }),
      );
      expect(statusOf(results, 'P08')).toBe('FAIL');
      expect(detailOf(results, 'P08')).toBe('403 forbidden');
      expect(statusOf(results, 'P14')).toBe('FAIL');
      expectUnnamed(w, MAILBOX);
    });
  });

  it('prints ids, statuses and reason codes only', async () => {
    const results = await runProbe(deps(world().fetchImpl, { ...admits(), outOfScope: { address: OUT_OF_SCOPE } }));
    const lines = results.map(formatProbeLine).join('\n');
    expect(lines).toContain('P07 PASS');
    expect(lines).not.toContain('access-for-');
    expect(lines).not.toContain('caller-token');
    expect(lines).not.toContain(MAILBOX);
    expect(lines).not.toContain(OUT_OF_SCOPE);
  });

  it('turns any failure into one fixed-code line', () => {
    expect(probeErrorLine(new ProbeCodeError('registration_not_found'))).toBe('{"evt":"probe_error","reason":"registration_not_found"}');
    expect(probeErrorLine(new TypeError('canary in a message'))).toBe('{"evt":"probe_error","reason":"internal:TypeError"}');
  });
});

// ── The guard builder, against a fake database and the guard's own (fake) service client ─────────

type Source = { tenant_id: string; kind: string; address: string; owner_user_id: string | null };
type Allowed = { tenant_id: string; provider: string; address: string; user_id: string };
type Registration = Record<string, string | null>;
type FakeState = {
  registrations?: Registration[] | 'error';
  sources?: Source[] | 'error';
  allowed?: Allowed[];
  users?: Array<{ email: string }> | 'error';
  invites?: Array<{ email: string }>;
  guardError?: boolean;
};
const CANARY = 'canary-7f3a';

/** A chainable supabase-js stand-in over the state: eq, ilike (case-insensitive equality), and the rest pass through. */
function fakeDb(state: FakeState) {
  const guardCalls: Array<Record<string, unknown>> = [];
  const tables: Record<string, () => unknown[] | 'error'> = {
    google_reader_registrations: () => state.registrations ?? [],
    content_sources: () => state.sources ?? [],
    allowed_mailboxes: () => state.allowed ?? [],
    users: () => state.users ?? [],
    invites: () => state.invites ?? [],
  };
  const fromCalls: string[] = [];
  const from = (table: string) => {
    fromCalls.push(table);
    const filters: Array<[op: 'eq' | 'ilike', column: string, value: unknown]> = [];
    const answer = () => {
      const rows = tables[table]?.() ?? [];
      if (rows === 'error') return { data: null, error: { message: `relation failed near ${CANARY}`, code: 'XX000' } };
      return {
        data: (rows as Array<Record<string, unknown>>).filter((row) =>
          filters.every(([op, column, value]) =>
            !(column in row) ? true : op === 'eq' ? row[column] === value : String(row[column]).toLowerCase() === String(value).toLowerCase(),
          ),
        ),
        error: null,
      };
    };
    const builder = {
      select: () => builder,
      eq: (column: string, value: unknown) => (filters.push(['eq', column, value]), builder),
      ilike: (column: string, value: unknown) => (filters.push(['ilike', column, value]), builder),
      order: () => builder,
      range: () => builder,
      limit: () => builder,
      maybeSingle: async () => {
        const { data, error } = answer();
        return { data: data?.[0] ?? null, error };
      },
      then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => Promise.resolve(answer()).then(resolve, reject),
    };
    return builder;
  };
  // mailbox_guard_check, as mailbox_guard_verdict decides it, coalesced with the caller's provider reason.
  const verdict = (args: Record<string, unknown>): string | null => {
    const address = String(args.p_address).toLowerCase();
    const sources = state.sources === 'error' ? [] : (state.sources ?? []);
    const source = sources.find((s) => s.tenant_id === args.p_tenant_id && s.address.toLowerCase() === address);
    if (!source) return 'no_source';
    const allowed = (state.allowed ?? []).find((a) => a.tenant_id === args.p_tenant_id && a.address === address);
    if (allowed) {
      if (source.owner_user_id !== allowed.user_id) return 'owner_mismatch';
      if (!args.p_owner_user_id || args.p_owner_user_id !== allowed.user_id) return 'owner_mismatch';
      return null;
    }
    return 'no_consent';
  };
  const rpc = async (name: string, args: Record<string, unknown>) => {
    if (name === 'discovery_record_allowlist_drift') return { data: null, error: null };
    if (name === 'mailbox_guard_check') {
      guardCalls.push(args);
      if (state.guardError) return { data: null, error: { message: `guard failed near ${CANARY}` } };
      return { data: verdict(args) ?? (args.p_provider_reason as string | null) ?? null, error: null };
    }
    return { data: null, error: { message: `unknown rpc ${name}` } };
  };
  return { db: { from, rpc } as unknown as SupabaseClient, guardCalls, fromCalls };
}

const mirrorOf = (members: string[] | Error) => {
  const listMembers = vi.fn(async () => {
    if (members instanceof Error) throw members;
    return members;
  });
  return { mirror: { listMembers } as ProviderAllowlistMirror, listMembers };
};

const consented = (): FakeState => ({
  sources: [
    { tenant_id: TENANT, kind: 'mailbox', address: 'Storm.Duncan@bank.example', owner_user_id: PERSONA_ID },
  ],
  allowed: [{ tenant_id: TENANT, provider: 'google', address: MAILBOX, user_id: PERSONA_ID }],
});

function withAdmin(state: FakeState) {
  const fake = fakeDb(state);
  admin.client = fake.db;
  return fake;
}

describe('buildProbeGuard asks the guard the way the worker does', () => {
  beforeEach(() => {
    admin.client = null;
  });

  it('binds the source owner, provider google and the group decision; the consented persona is admitted', async () => {
    const fake = withAdmin(consented());
    const { mirror } = mirrorOf([MAILBOX, 'other@bank.example']);
    const guard = buildProbeGuard(fake.db, TENANT, mirror);
    expect(await guard.guardFor(MAILBOX)).toBeNull();
    expect(fake.guardCalls).toEqual([
      expect.objectContaining({
        p_tenant_id: TENANT,
        p_address: MAILBOX,
        p_purpose: 'provider_read',
        p_caller: PROBE_GUARD_CALLER,
        p_check_owner: true,
        p_owner_user_id: PERSONA_ID,
        p_provider: 'google',
        p_provider_reason: null,
      }),
    ]);
    expect(await guard.group()).toMatchObject({ count: 2 });
  });

  it('reads the group once for every guard call', async () => {
    const fake = withAdmin(consented());
    const { mirror, listMembers } = mirrorOf([MAILBOX]);
    const guard = buildProbeGuard(fake.db, TENANT, mirror);
    await guard.group();
    await guard.guardFor(MAILBOX);
    await guard.guardFor(OUT_OF_SCOPE);
    expect(listMembers).toHaveBeenCalledTimes(1);
  });

  it('a consented persona absent from the group is refused not_in_provider_group: P14 FAIL, nothing names it', async () => {
    const fake = withAdmin(consented());
    const { mirror } = mirrorOf(['someone-else@bank.example']);
    const guard = buildProbeGuard(fake.db, TENANT, mirror);
    const w = world();
    const results = await runProbe(deps(w.fetchImpl, { ...guard }));
    expect(fake.guardCalls[0]).toMatchObject({ p_provider_reason: 'not_in_provider_group', p_owner_user_id: PERSONA_ID });
    expect(statusOf(results, 'P14')).toBe('FAIL');
    expect(detailOf(results, 'P14')).toBe('refused not_in_provider_group');
    expectUnnamed(w, MAILBOX);
  });

  it('binds no owner for an address with no source, and the guard says no_source', async () => {
    const fake = withAdmin(consented());
    const guard = buildProbeGuard(fake.db, TENANT, mirrorOf([MAILBOX]).mirror);
    expect(await guard.guardFor(OUT_OF_SCOPE)).toBe('no_source');
    expect(fake.guardCalls[0]).toMatchObject({ p_owner_user_id: null, p_provider_reason: 'not_in_provider_group' });
  });

  it('an allowlist whose source has another owner is owner_mismatch, never admitted', async () => {
    const state = consented();
    (state.sources as Source[])[0].owner_user_id = OTHER_ID;
    const fake = withAdmin(state);
    const guard = buildProbeGuard(fake.db, TENANT, mirrorOf([MAILBOX]).mirror);
    expect(await guard.guardFor(MAILBOX)).toBe('owner_mismatch');
  });

  it.each([
    ['the source lookup fails', { ...consented(), sources: 'error' as const }, 'source_lookup_failed'],
    ['the guard RPC fails', { ...consented(), guardError: true }, 'guard_unavailable'],
  ])('%s: a fixed code, and the database message reaches no line', async (_name, state, code) => {
    const fake = withAdmin(state);
    const guard = buildProbeGuard(fake.db, TENANT, mirrorOf([MAILBOX]).mirror);
    await expect(guard.guardFor(MAILBOX)).rejects.toMatchObject({ code, message: code });
    const w = world();
    const results = await runProbe(deps(w.fetchImpl, { ...buildProbeGuard(fake.db, TENANT, mirrorOf([MAILBOX]).mirror) }));
    expect(statusOf(results, 'P14')).toBe('FAIL');
    expect(detailOf(results, 'P14')).toBe(`the guard could not be asked: ${code}`);
    expect(JSON.stringify(results)).not.toContain(CANARY);
    expectUnnamed(w, MAILBOX);
  });

  it('a group that cannot be read fails P14 closed and P08 with the HTTP status', async () => {
    const fake = withAdmin(consented());
    const guard = buildProbeGuard(fake.db, TENANT, mirrorOf(new GoogleHttpError(403, 'forbidden', 1)).mirror);
    await expect(guard.group()).rejects.toMatchObject({ code: 'group_unavailable' });
    const w = world();
    const results = await runProbe(deps(w.fetchImpl, { ...buildProbeGuard(fake.db, TENANT, mirrorOf(new GoogleHttpError(403, 'forbidden', 1)).mirror) }));
    expect(statusOf(results, 'P14')).toBe('FAIL');
    expect(detailOf(results, 'P08')).toBe('403 forbidden');
    expect(fake.guardCalls).toEqual([]);
    expectUnnamed(w, MAILBOX);
  });

  describe('registeredOutOfScope', () => {
    it.each([
      ['a Conductia user (any case)', { users: [{ email: 'Probe-Out-Of-Scope@bank.example' }] }],
      ['an invitee', { invites: [{ email: OUT_OF_SCOPE }] }],
      ['allowlisted', { allowed: [{ tenant_id: TENANT, provider: 'google', address: OUT_OF_SCOPE, user_id: OTHER_ID }] }],
      [
        'a mailbox source in the tenant (any case), even with no owner',
        { sources: [{ tenant_id: TENANT, kind: 'mailbox', address: 'Probe-Out-Of-Scope@bank.example', owner_user_id: null }] },
      ],
    ])('refuses %s', async (_name, state) => {
      const fake = fakeDb(state);
      expect(await buildProbeGuard(fake.db, TENANT, mirrorOf([]).mirror).registeredOutOfScope(OUT_OF_SCOPE)).toBe(false);
    });

    it('accepts an address with no users, invites or allowed_mailboxes row, and an _ in a stored address is no wildcard', async () => {
      const fake = fakeDb({ users: [{ email: 'probe_out-of-scope@bank.example' }] });
      expect(await buildProbeGuard(fake.db, TENANT, mirrorOf([]).mirror).registeredOutOfScope(OUT_OF_SCOPE)).toBe(true);
    });

    it('a mailbox source in another tenant, or a source of another kind, does not count', async () => {
      const fake = fakeDb({
        sources: [
          { tenant_id: OTHER_ID, kind: 'mailbox', address: OUT_OF_SCOPE, owner_user_id: null },
          { tenant_id: TENANT, kind: 'drive', address: OUT_OF_SCOPE, owner_user_id: null },
        ],
      });
      expect(await buildProbeGuard(fake.db, TENANT, mirrorOf([]).mirror).registeredOutOfScope(OUT_OF_SCOPE)).toBe(true);
    });

    it.each([['users', { users: 'error' as const }], ['content_sources', { sources: 'error' as const }]])(
      'a failing %s lookup is a fixed code',
      async (_name, state) => {
        const fake = fakeDb(state);
        await expect(buildProbeGuard(fake.db, TENANT, mirrorOf([]).mirror).registeredOutOfScope(OUT_OF_SCOPE)).rejects.toMatchObject({
          code: 'out_of_scope_lookup_failed',
        });
      },
    );

    it('a failing lookup is a fixed code', async () => {
      const fake = fakeDb({ users: 'error' });
      await expect(buildProbeGuard(fake.db, TENANT, mirrorOf([]).mirror).registeredOutOfScope(OUT_OF_SCOPE)).rejects.toMatchObject({
        code: 'out_of_scope_lookup_failed',
      });
    });
  });
});

// ── The CLI: --tenant from the registration row, addresses from env, fixed codes ──────────────────

const ROW: Registration = {
  tenant_id: TENANT,
  workspace_domain: DOMAIN,
  service_account_email: DWD,
  client_id: '123456789012345678',
  directory_service_account_email: DIR_SA,
  allowlist_group: GROUP,
  firm_company_id: null,
  status: 'active',
};

describe('probeMain', () => {
  let cwd: string;
  let out: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'probe-cwd-'));
    out = mkdtempSync(join(tmpdir(), 'probe-out-'));
    admin.client = null;
  });

  const TENANT_ARGV = ['--live', '--confirm-domain', DOMAIN, '--tenant', TENANT, '--out', '<out>'];
  const baseEnv = () => ({
    GOOGLE_APPLICATION_CREDENTIALS: credentials,
    NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
    SUPABASE_SECRET_KEY: 'local-test-key',
    PROBE_MAILBOX: MAILBOX,
    PROBE_OUT_OF_SCOPE: OUT_OF_SCOPE,
  });

  async function cli(argv: string[], env: Record<string, string | undefined>, state: FakeState = { ...consented(), registrations: [ROW] }) {
    const fake = withAdmin(state);
    const w = world();
    const lines: string[] = [];
    const dbBuilt = vi.fn(() => fake.db);
    const callerBuilt = vi.fn(() => async () => 'caller-token');
    const code = await probeMain(
      argv.map((a) => (a === '<out>' ? out : a)),
      {
        env,
        cwd,
        io: { log: (line) => lines.push(line) },
        db: dbBuilt,
        mirror: () => mirrorOf([MAILBOX]).mirror,
        callerToken: callerBuilt,
        directoryToken: () => null,
        fetchImpl: w.fetchImpl,
      },
    );
    const reports = readdirSync(out).map((name) => readFileSync(join(out, name), 'utf8'));
    return { code, lines, w, fake, dbBuilt, callerBuilt, reports, output: lines.join('\n') };
  }

  it('runs from the registration row with the addresses from env: P14 and P13 PASS, no address in any line or the report', async () => {
    const run = await cli(TENANT_ARGV, baseEnv());
    expect(run.code).toBe(0);
    expect(run.lines[0]).toBe('Guard database: 127.0.0.1');
    expect(run.lines[1]).toBe(`LIVE Google run: google:probe against ${DOMAIN} for tenant ${TENANT}`);
    expect(run.output).toMatch(/^P14 PASS/m);
    expect(run.output).toMatch(/^P13 PASS/m);
    // The row's identities are the ones the probe used.
    expect(run.w.signed.some((c) => c.iss === DWD && c.sub === MAILBOX)).toBe(true);
    expect(run.fake.fromCalls).toContain('google_reader_registrations');
    expect(run.reports).toHaveLength(1);
    const report = JSON.parse(run.reports[0]) as { tenantId: string; domain: string; results: ProbeResult[] };
    expect(report).toMatchObject({ tenantId: TENANT, domain: DOMAIN });
    for (const text of [run.output, run.reports[0]]) {
      expect(text).not.toContain(MAILBOX);
      expect(text).not.toContain(OUT_OF_SCOPE);
      expect(text).not.toContain(DWD);
    }
  });

  it('refuses an unknown tenant before any Google call', async () => {
    const run = await cli(TENANT_ARGV, baseEnv(), { ...consented(), registrations: [] });
    expect(run.code).toBe(1);
    expect(run.lines).toEqual(['{"evt":"probe_error","reason":"registration_not_found"}']);
    expect(run.w.requests).toEqual([]);
    expect(run.callerBuilt).not.toHaveBeenCalled();
    expect(run.reports).toEqual([]);
  });

  it.each([
    ['--mailbox', ['--mailbox', MAILBOX]],
    ['--out-of-scope', ['--out-of-scope', OUT_OF_SCOPE]],
  ])('refuses %s on the command line in --tenant mode, before the database', async (_name, extra) => {
    const run = await cli([...TENANT_ARGV, ...extra], baseEnv());
    expect(run.lines).toEqual(['{"evt":"probe_error","reason":"arg_on_argv_in_tenant_mode"}']);
    expect(run.dbBuilt).not.toHaveBeenCalled();
  });

  it.each([
    ['a second @', { PROBE_MAILBOX: `can@ry@${DOMAIN}` }, 'arg_malformed_address'],
    ['a newline', { PROBE_MAILBOX: `${CANARY}\n@${DOMAIN}` }, 'arg_malformed_address'],
    ['another domain', { PROBE_MAILBOX: `${CANARY}@evil.example` }, 'arg_out_of_domain'],
    ['an out-of-scope address with a second @', { PROBE_OUT_OF_SCOPE: `${CANARY}@x@${DOMAIN}` }, 'arg_malformed_address'],
    ['an out-of-scope address in another domain', { PROBE_OUT_OF_SCOPE: `${CANARY}@evil.example` }, 'arg_out_of_domain'],
  ])('a canary in %s reaches no line or report', async (_name, env, code) => {
    const run = await cli(TENANT_ARGV, { ...baseEnv(), ...env });
    expect(run.code).toBe(1);
    expect(run.lines).toEqual([`{"evt":"probe_error","reason":"${code}"}`]);
    expect(run.output).not.toContain(CANARY);
    expect(run.output).not.toContain('ry@');
    expect(run.w.requests).toEqual([]);
    expect(run.reports).toEqual([]);
  });

  it('in --tenant mode P05 reads only PROBE_RAW_TEST_MESSAGE_ID, and is SKIPPED without it', async () => {
    const without = await cli(TENANT_ARGV, baseEnv());
    expect(without.output).toMatch(/^P05 SKIPPED .*no designated test message/m);
    expect(without.w.requests.some((r) => r.url.includes('format=raw'))).toBe(false);
    const withId = await cli(TENANT_ARGV, { ...baseEnv(), PROBE_RAW_TEST_MESSAGE_ID: RAW_TEST_MESSAGE });
    expect(withId.w.requests.filter((r) => r.url.includes('format=raw')).map((r) => r.url)).toEqual([
      `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(MAILBOX)}/messages/${RAW_TEST_MESSAGE}?format=raw&fields=${GMAIL_PROBE_RAW_FIELDS}`,
    ]);
    const bad = await cli(TENANT_ARGV, { ...baseEnv(), PROBE_RAW_TEST_MESSAGE_ID: `${CANARY}\n` });
    expect(bad.lines).toEqual(['{"evt":"probe_error","reason":"arg_malformed_message_id"}']);
    expect(bad.dbBuilt).not.toHaveBeenCalled();
  });

  it('a canary in a failing registration lookup reaches no line or report', async () => {
    const run = await cli(TENANT_ARGV, baseEnv(), { ...consented(), registrations: 'error' });
    expect(run.lines).toEqual(['{"evt":"probe_error","reason":"registration_lookup_failed"}']);
    expect(run.output).not.toContain(CANARY);
    expect(run.reports).toEqual([]);
  });

  it('a canary in a failing source lookup fails the out-of-scope check first, before any Google call', async () => {
    const run = await cli(TENANT_ARGV, baseEnv(), { ...consented(), registrations: [ROW], sources: 'error' });
    expect(run.code).toBe(1);
    expect(run.lines.at(-1)).toBe('{"evt":"probe_error","reason":"out_of_scope_lookup_failed"}');
    expect(run.output).not.toContain(CANARY);
    expect(run.w.requests).toEqual([]);
    expect(run.reports).toEqual([]);
  });

  it('a canary in a failing source lookup reaches no line or report (P14 FAIL, exit 1)', async () => {
    const run = await cli(TENANT_ARGV, { ...baseEnv(), PROBE_OUT_OF_SCOPE: undefined }, { ...consented(), registrations: [ROW], sources: 'error' });
    expect(run.code).toBe(1);
    expect(run.output).toMatch(/^P14 FAIL .*source_lookup_failed/m);
    expect(run.output).not.toContain(CANARY);
    expect(run.reports.join('')).not.toContain(CANARY);
    expectUnnamed(run.w, MAILBOX);
  });

  it.each(['prod', 'production', ' Prod '])('refuses the legacy JWT key in production (%j) first (secret_key_shape)', async (appEnv) => {
    const run = await cli(TENANT_ARGV, { ...baseEnv(), NEXT_PUBLIC_APP_ENV: appEnv, SUPABASE_SECRET_KEY: `eyJ.${CANARY}.sig` });
    expect(run.lines).toEqual(['{"evt":"probe_error","reason":"secret_key_shape"}']);
    expect(run.dbBuilt).not.toHaveBeenCalled();
  });

  it('refuses a remote database without --allow-remote-db', async () => {
    const run = await cli(TENANT_ARGV, { ...baseEnv(), NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co' });
    expect(run.lines).toEqual(['{"evt":"probe_error","reason":"arg_remote_db"}']);
    expect(run.dbBuilt).not.toHaveBeenCalled();
  });

  it.each([
    ['no arguments', [], 'arg_live_required'],
    ['no registration source', ['--live'], 'arg_missing'],
    ['both registration sources', ['--live', '--tenant', TENANT, '--registration', 'r.json'], 'arg_conflict'],
    ['a malformed tenant id', ['--live', '--tenant', `${CANARY}`], 'arg_malformed_tenant'],
    ['a flag with no value', ['--live', '--tenant'], 'arg_missing'],
  ])('%s: one fixed-code line', async (_name, argv, code) => {
    const run = await cli(argv, baseEnv());
    expect(run.code).toBe(1);
    expect(run.lines).toEqual([`{"evt":"probe_error","reason":"${code}"}`]);
    expect(run.output).not.toContain(CANARY);
  });

  it('refuses a --confirm-domain that is not the registration domain', async () => {
    const run = await cli(['--live', '--confirm-domain', 'other.example', '--tenant', TENANT, '--out', '<out>'], baseEnv());
    expect(run.lines).toEqual(['{"evt":"probe_error","reason":"arg_confirm_domain"}']);
    expect(run.w.requests).toEqual([]);
  });

  describe('file mode (a laptop)', () => {
    const fileArgv = (extra: string[] = []) => {
      const file = join(cwd, 'registration.json');
      writeFileSync(file, JSON.stringify(REGISTRATION));
      return ['--live', '--confirm-domain', DOMAIN, '--registration', file, '--mailbox', MAILBOX, '--out', '<out>', ...extra];
    };

    it('without --guard-db: no database, P14 PENDING, nothing names the persona, and the run is not green', async () => {
      const run = await cli(fileArgv(), { GOOGLE_APPLICATION_CREDENTIALS: credentials });
      expect(run.code).toBe(1);
      expect(run.dbBuilt).not.toHaveBeenCalled();
      expect(run.output).toMatch(/^P14 PENDING/m);
      expectUnnamed(run.w, MAILBOX);
    });

    it('with --guard-db and the out-of-scope account: the guard on the local database, P14 and P13 PASS', async () => {
      const run = await cli(fileArgv(['--guard-db', '--out-of-scope', OUT_OF_SCOPE]), baseEnv());
      expect(run.code).toBe(0);
      expect(run.output).toMatch(/^P14 PASS/m);
      expect(run.output).toMatch(/^P13 PASS/m);
      expect(run.fake.guardCalls[0]).toMatchObject({ p_owner_user_id: PERSONA_ID });
    });

    it.each(['prod', ' Production '])('in production (%j) the guard is mandatory', async (appEnv) => {
      const run = await cli(fileArgv(), { GOOGLE_APPLICATION_CREDENTIALS: credentials, NEXT_PUBLIC_APP_ENV: appEnv });
      expect(run.lines).toEqual(['{"evt":"probe_error","reason":"arg_guard_required"}']);
    });

    it('with --guard-db in production, refuses a legacy JWT key before the database (secret_key_shape)', async () => {
      const run = await cli(fileArgv(['--guard-db', '--allow-remote-db']), {
        ...baseEnv(),
        NEXT_PUBLIC_APP_ENV: 'PROD',
        NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
        SUPABASE_SECRET_KEY: `eyJ.${CANARY}.sig`,
      });
      expect(run.lines).toEqual(['{"evt":"probe_error","reason":"secret_key_shape"}']);
      expect(run.output).not.toContain(CANARY);
      expect(run.dbBuilt).not.toHaveBeenCalled();
      expect(run.w.requests).toEqual([]);
    });

    it('reads the designated P05 message from the registration file, and refuses a malformed one', async () => {
      const file = join(cwd, 'registration.json');
      const argv = ['--live', '--confirm-domain', DOMAIN, '--registration', file, '--mailbox', MAILBOX, '--guard-db', '--out', '<out>'];
      writeFileSync(file, JSON.stringify({ ...REGISTRATION, rawTestMessageId: RAW_TEST_MESSAGE }));
      const ok = await cli(argv, baseEnv());
      expect(ok.output).toMatch(/^P05 PASS/m);
      expect(ok.w.requests.filter((r) => r.url.includes('format=raw'))).toHaveLength(1);
      writeFileSync(file, JSON.stringify({ ...REGISTRATION, rawTestMessageId: `${CANARY}/x` }));
      const bad = await cli(argv, baseEnv());
      expect(bad.lines).toEqual(['{"evt":"probe_error","reason":"arg_malformed_message_id"}']);
      expect(bad.output).not.toContain(CANARY);
      expect(bad.w.requests).toEqual([]);
    });

    it('an unreadable registration file is a fixed code', async () => {
      const run = await cli(['--live', '--registration', join(cwd, 'missing.json')], baseEnv());
      expect(run.lines).toEqual(['{"evt":"probe_error","reason":"registration_file_unreadable"}']);
    });
  });
});
