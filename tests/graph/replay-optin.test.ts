// @vitest-environment node
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertOptinTarget,
  openOptinWindow,
  optinProfileUrl,
  parseOptinTimeoutSeconds,
} from '../../scripts/m365/replay-discovery';

/*
 * --activate-for-optin (D68, owner decision): the flag OPENS THE WINDOW ONLY. The replay registration is `disabled`
 * at rest and an owner's opt-in needs an active one, so the flag holds it active while the owners opt in themselves
 * (on /profile, with their own session), polls their consent read-only, and sets the registration back to
 * `disabled` on every way out. It never signs in as an owner and never writes a consent. These tests pin the
 * window: it closes on every path, and nothing in its path writes mailbox_consents.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const OWNER_A = '22222222-2222-4222-8222-222222222221';
const OWNER_B = '22222222-2222-4222-8222-222222222222';
const INVITE_A = '33333333-3333-4333-8333-333333333331';
const INVITE_B = '33333333-3333-4333-8333-333333333332';
const APP = 'http://localhost:3000';

type Write = { table: string; op: string; values?: unknown };

type World = {
  /** Registration status the fake keeps; the seated-invites view reads empty unless it is 'active' (as the real one). */
  status: string;
  seated: Array<{ address: string; user_id: string; invite_id: string }>;
  consented: Set<string>;
  failStatus?: string;
  /** A status write that fails (`failStatus`) still lands, as when the database commits and the response is lost. */
  commitOnFail?: boolean;
  /** How many conditional disables (`where status = 'active'`) fail first, to exercise the retries. */
  disableFailures?: number;
  failRead?: boolean;
  /** Called on every poll of the seated-invites view, with the 1-based poll number. */
  onPoll?: (poll: number) => void;
  /** A poll that never answers: it settles only when its AbortSignal aborts, as an unanswered request does. */
  hangPoll?: (poll: number) => boolean;
};

/** A db that logs every state change in order and records every write, and answers the two read-only polls. */
function fakeDb(world: World, log: string[], writes: Write[]) {
  let polls = 0;
  const read = (table: string) => {
    const filters: Array<[string, unknown]> = [];
    let signal: AbortSignal | undefined;
    const builder: Record<string, unknown> = {};
    builder.abortSignal = (value: AbortSignal) => {
      signal = value;
      return builder;
    };
    // The read-back of the registration's status, as the cleanup after a failed activation makes it.
    builder.maybeSingle = () => Promise.resolve({ data: { status: world.status }, error: null });
    for (const method of ['eq', 'in', 'is'] as const) {
      builder[method] = (column: string, value: unknown) => {
        filters.push([`${method}:${column}`, value]);
        return builder;
      };
    }
    builder.then = (resolveRead: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
      if (table === 'mailbox_seated_invites' && world.hangPoll?.(polls + 1)) {
        polls += 1;
        world.onPoll?.(polls);
        // postgrest-js reports an aborted request as an error result, it does not throw.
        const aborted = { data: null, error: { message: 'AbortError: The operation was aborted.' } };
        return new Promise((settle) => {
          if (signal?.aborted) settle(aborted);
          else signal?.addEventListener('abort', () => settle(aborted));
        }).then(resolveRead, reject);
      }
      const answer = (() => {
        if (world.failRead) return { data: null, error: { message: 'boom' } };
        if (table === 'mailbox_seated_invites') {
          polls += 1;
          world.onPoll?.(polls);
          const wanted = (filters.find(([k]) => k === 'in:user_id')?.[1] ?? []) as string[];
          const rows = world.status === 'active' ? world.seated.filter((row) => wanted.includes(row.user_id)) : [];
          return { data: rows, error: null };
        }
        if (table === 'mailbox_consents') {
          const wanted = (filters.find(([k]) => k === 'in:invite_id')?.[1] ?? []) as string[];
          return { data: wanted.filter((id) => world.consented.has(id)).map((invite_id) => ({ invite_id })), error: null };
        }
        return { data: [], error: null };
      })();
      return Promise.resolve(answer).then(resolveRead, reject);
    };
    return builder;
  };
  const write = (table: string, op: string) => (values?: unknown) => {
    writes.push({ table, op, values });
    throw new Error(`unexpected ${op} on ${table}`);
  };
  return {
    from: (table: string) => ({
      select: () => {
        log.push(`${table}:select`);
        return read(table);
      },
      insert: write(table, 'insert'),
      upsert: write(table, 'upsert'),
      delete: write(table, 'delete'),
      update: (values: { status: string }) => {
        writes.push({ table, op: 'update', values });
        let onlyIfStatus: string | null = null;
        const chain = {
          eq: (column: string, value: string) => {
            if (column === 'ms_tenant_id') log.push(`${table}.${column}=${value}`);
            if (column === 'status') {
              onlyIfStatus = value;
              log.push(`${table}.${column}=${value}`);
            }
            return chain;
          },
          abortSignal: () => chain,
          select: async () => {
            log.push(`${table}:${values.status}`);
            if (onlyIfStatus !== null) {
              // The conditional disable: it changes nothing unless the registration is in that status.
              if ((world.disableFailures ?? 0) > 0) {
                world.disableFailures = (world.disableFailures ?? 0) - 1;
                return { data: null, error: { message: 'disable refused' } };
              }
              if (world.status !== onlyIfStatus) return { data: [], error: null };
              world.status = values.status;
              return { data: [{ tenant_id: TENANT }], error: null };
            }
            if (values.status === world.failStatus) {
              if (world.commitOnFail) world.status = values.status;
              return { data: null, error: { message: 'boom' } };
            }
            world.status = values.status;
            return { data: [{ tenant_id: TENANT }], error: null };
          },
        };
        return chain;
      },
    }),
  } as unknown as SupabaseClient;
}

const newWorld = (over: Partial<World> = {}): World => ({
  status: 'disabled',
  seated: [
    { address: 'a@bank.example', user_id: OWNER_A, invite_id: INVITE_A },
    { address: 'b@bank.example', user_id: OWNER_B, invite_id: INVITE_B },
  ],
  consented: new Set(),
  ...over,
});

const OWNERS = new Map<string, string | null>([
  ['a@bank.example', OWNER_A],
  ['b@bank.example', OWNER_B],
  ['site.example', OWNER_B], // an owner of two sources is one owner
  ['unowned@bank.example', null], // nobody to opt in
]);

const REGISTRATION = 'graph_reader_registrations';
/** The registration status changes, in order. */
const statusChanges = (log: string[]) => log.filter((entry) => entry.startsWith(`${REGISTRATION}:`));

type Harness = { world: World; log: string[]; writes: Write[]; lines: string[]; db: SupabaseClient; signals: EventEmitter; stdin: EventEmitter };
function harness(over: Partial<World> = {}): Harness {
  const world = newWorld(over);
  const log: string[] = [];
  const writes: Write[] = [];
  return { world, log, writes, lines: [], db: fakeDb(world, log, writes), signals: new EventEmitter(), stdin: new EventEmitter() };
}
const open = (h: Harness, options: { timeoutMs?: number; stdin?: EventEmitter | null } = {}) =>
  openOptinWindow(h.db, TENANT, OWNERS, {
    timeoutMs: options.timeoutMs ?? 5_000,
    pollMs: 5,
    appUrl: APP,
    log: (line) => h.lines.push(line),
    signals: h.signals,
    stdin: options.stdin === undefined ? h.stdin : options.stdin,
  });

/** The invariants of every path: closed again, and the only writes are the registration's own status changes. */
function expectClosedAndReadOnly(h: Harness) {
  expect(h.world.status).toBe('disabled');
  expect(statusChanges(h.log)).toEqual([`${REGISTRATION}:active`, `${REGISTRATION}:disabled`]);
  expect(h.writes.every((w) => w.table === REGISTRATION && w.op === 'update')).toBe(true);
  expect(h.writes.map((w) => w.values)).toEqual([{ status: 'active' }, { status: 'disabled' }]);
  expect(h.writes.some((w) => w.table === 'mailbox_consents')).toBe(false);
  expect(h.log.filter((entry) => entry.endsWith(':select')).every((entry) => ['mailbox_seated_invites:select', 'mailbox_consents:select'].includes(entry))).toBe(true);
  expect(h.signals.listenerCount('SIGINT')).toBe(0);
  expect(h.signals.listenerCount('SIGTERM')).toBe(0);
  expect(h.stdin.listenerCount('data')).toBe(0);
}

afterEach(() => vi.restoreAllMocks());

describe('openOptinWindow: the registration is active while the owners opt in themselves, and disabled on every path', () => {
  it('all consented: active, polls read-only, then disabled, touching a replay registration only', async () => {
    const h = harness({
      onPoll: (poll) => {
        if (poll === 2) h.world.consented.add(INVITE_A); // the owners opt in on /profile, outside this script
        if (poll === 3) h.world.consented.add(INVITE_B);
      },
    });
    const result = await open(h);
    expect(result?.endedBy).toBe('all_consented');
    expect(result?.owners.map((o) => [o.label, o.consented])).toEqual([[1, true], [2, true]]);
    expectClosedAndReadOnly(h);
    expect(h.log.filter((entry) => entry.startsWith(`${REGISTRATION}.ms_tenant_id=`))).toEqual([
      `${REGISTRATION}.ms_tenant_id=replay`,
      `${REGISTRATION}.ms_tenant_id=replay`,
    ]);
    // Active before the first poll, disabled after the last.
    expect(h.log.indexOf(`${REGISTRATION}:active`)).toBeLessThan(h.log.indexOf('mailbox_seated_invites:select'));
    expect(h.log.lastIndexOf('mailbox_seated_invites:select')).toBeLessThan(h.log.indexOf(`${REGISTRATION}:disabled`));
  });

  it('the poll is a read: only select on the seated invites and the consents, never a write', async () => {
    const h = harness({ onPoll: (poll) => poll === 3 && h.world.consented.add(INVITE_A) && h.world.consented.add(INVITE_B) });
    await open(h);
    const reads = h.log.filter((entry) => entry.endsWith(':select') && !entry.startsWith(`${REGISTRATION}:`));
    expect(reads.length).toBeGreaterThanOrEqual(4); // at least two polls, each reading both tables
    expect(new Set(reads)).toEqual(new Set(['mailbox_seated_invites:select', 'mailbox_consents:select']));
    expect(new Set(h.writes.map((w) => w.table))).toEqual(new Set([REGISTRATION]));
  });

  it('timeout: the window closes, the owners who did not opt in are reported, nothing was written but the status', async () => {
    const h = harness();
    const result = await open(h, { timeoutMs: 40 });
    expect(result?.endedBy).toBe('timeout');
    expect(result?.owners.every((o) => !o.consented)).toBe(true);
    expectClosedAndReadOnly(h);
  });

  it('Enter ends the wait, and a partial opt-in is reported as it stands', async () => {
    const h = harness({
      onPoll: (poll) => {
        if (poll === 2) h.world.consented.add(INVITE_A);
        if (poll === 3) h.stdin.emit('data', Buffer.from('\n'));
      },
    });
    const result = await open(h);
    expect(result?.endedBy).toBe('enter');
    expect(result?.owners.map((o) => o.consented)).toEqual([true, false]);
    expectClosedAndReadOnly(h);
  });

  it('typing without Enter, and the end of a non-interactive stdin, do not end the wait', async () => {
    const h = harness({
      onPoll: (poll) => {
        if (poll === 2) h.stdin.emit('data', Buffer.from('abc'));
        if (poll === 3) h.stdin.emit('end');
      },
    });
    const result = await open(h, { timeoutMs: 60 });
    expect(result?.endedBy).toBe('timeout');
    expectClosedAndReadOnly(h);
  });

  it('with no stdin to read, the wait runs to consent or timeout', async () => {
    const h = harness();
    expect((await open(h, { timeoutMs: 30, stdin: null }))?.endedBy).toBe('timeout');
    expectClosedAndReadOnly(h);
  });

  it('a failure during the wait closes the window and is not hidden', async () => {
    const h = harness();
    h.world.failRead = true;
    await expect(open(h)).rejects.toThrow('boom');
    expectClosedAndReadOnly(h);
  });

  it('a window that cannot be closed says so, and a failure that came first is not hidden by it', async () => {
    const closing = harness({ failStatus: 'disabled' });
    await expect(open(closing, { timeoutMs: 20 })).rejects.toThrow(/registration disabled failed/);
    const both = harness({ failStatus: 'disabled' });
    both.world.failRead = true;
    await expect(open(both)).rejects.toThrow('boom');
  });

  it.each(['SIGINT', 'SIGTERM'] as const)('%s during the wait ends the wait and closes the window; it does not exit the process', async (signal) => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const h = harness({
      onPoll: (poll) => {
        if (poll === 2) h.signals.emit(signal);
      },
    });
    const result = await open(h);
    expect(result?.endedBy).toBe('signal');
    expectClosedAndReadOnly(h);
    expect(exit).not.toHaveBeenCalled();
  });

  it('a signal that lands while the window is still opening ends the wait at once, and the window still closes', async () => {
    const h = harness();
    const pending = open(h);
    h.signals.emit('SIGINT'); // before the activation has resolved
    expect((await pending)?.endedBy).toBe('signal');
    expectClosedAndReadOnly(h);
  });

  it('never runs the wait when the registration cannot be activated', async () => {
    const h = harness({ failStatus: 'active' });
    await expect(open(h)).rejects.toThrow(/registration active failed/);
    // No poll was made. The only read is the registration's own status, by the cleanup after the failed activation.
    expect(h.log.filter((entry) => entry.endsWith(':select'))).toEqual([`${REGISTRATION}:select`]);
    expect(h.signals.listenerCount('SIGINT')).toBe(0);
  });

  it('nobody pending: an owner who already opted in, or has no seated invite, is not waited for', async () => {
    const h = harness({ consented: new Set([INVITE_A, INVITE_B]) });
    const result = await open(h);
    expect(result?.endedBy).toBe('none_pending');
    expectClosedAndReadOnly(h);

    const unseated = harness({ seated: [] });
    const none = await open(unseated, { timeoutMs: 5_000 }); // returns at once, not at the timeout
    expect(none?.endedBy).toBe('none_pending');
    expect(none?.owners.map((o) => [o.address, o.consented])).toEqual([[null, false], [null, false]]);
    expectClosedAndReadOnly(unseated);
  });

  it('with no owner there is nothing to opt in, and the registration is never touched', async () => {
    const h = harness();
    const result = await openOptinWindow(h.db, TENANT, new Map([['a@bank.example', null]]), { timeoutMs: 50, appUrl: APP, signals: h.signals, stdin: null });
    expect(result).toBeNull();
    expect(h.log).toEqual([]);
    expect(h.writes).toEqual([]);
  });
});

/** Fails the test, with a message, when `work` does not settle in `ms`: a hung window must not pass by timing out silently. */
async function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: still waiting after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

describe('openOptinWindow: a database that stops answering does not hold the registration active (round 3, M3)', () => {
  const withRequestTimeout = (h: Harness, options: { timeoutMs: number; requestTimeoutMs: number }) =>
    openOptinWindow(h.db, TENANT, OWNERS, {
      ...options,
      pollMs: 5,
      appUrl: APP,
      log: (line) => h.lines.push(line),
      signals: h.signals,
      stdin: null,
    });

  it('the deadline ends a first poll that never answers, aborts it, and the registration is disabled', async () => {
    const h = harness({ hangPoll: () => true });
    const started = Date.now();
    const result = await within(withRequestTimeout(h, { timeoutMs: 60, requestTimeoutMs: 60_000 }), 2_000, 'first poll');
    expect(result?.endedBy).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(h.world.status).toBe('disabled');
    expect(h.writes.map((w) => w.values)).toEqual([{ status: 'active' }, { status: 'disabled' }]);
    expect(h.signals.listenerCount('SIGINT')).toBe(0);
  });

  it('the deadline also ends a later poll that never answers', async () => {
    const h = harness({ hangPoll: (poll) => poll >= 3 });
    const started = Date.now();
    const result = await within(withRequestTimeout(h, { timeoutMs: 80, requestTimeoutMs: 60_000 }), 2_000, 'later poll');
    expect(result?.endedBy).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(h.world.status).toBe('disabled');
    expect(h.writes.map((w) => w.values)).toEqual([{ status: 'active' }, { status: 'disabled' }]);
  });

  it.each(['SIGINT', 'SIGTERM'] as const)('%s aborts a poll that never answers, and the registration is disabled promptly', async (signal) => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const h = harness({
      hangPoll: (poll) => poll === 2,
      onPoll: (poll) => {
        if (poll === 2) setTimeout(() => h.signals.emit(signal), 10);
      },
    });
    const started = Date.now();
    const result = await within(withRequestTimeout(h, { timeoutMs: 60_000, requestTimeoutMs: 60_000 }), 2_000, `${signal} during a poll`);
    expect(result?.endedBy).toBe('signal');
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(h.world.status).toBe('disabled');
    expect(h.writes.map((w) => w.values)).toEqual([{ status: 'active' }, { status: 'disabled' }]);
    expect(h.signals.listenerCount('SIGINT')).toBe(0);
    expect(exit).not.toHaveBeenCalled();
  });

  it('a poll that takes longer than the request timeout fails, is reported, and the registration is disabled', async () => {
    const h = harness({ hangPoll: () => true });
    await within(
      expect(withRequestTimeout(h, { timeoutMs: 60_000, requestTimeoutMs: 40 })).rejects.toThrow(/seated invite read failed/),
      2_000,
      'request timeout',
    );
    expect(h.world.status).toBe('disabled');
    expect(h.writes.map((w) => w.values)).toEqual([{ status: 'active' }, { status: 'disabled' }]);
  });
});

describe('openOptinWindow: an activation error does not leave the registration active (round 3, M4)', () => {
  const READBACK = `${REGISTRATION}:select`;
  const disables = (h: Harness) => h.writes.filter((w) => (w.values as { status: string }).status === 'disabled');

  it('an activation that commits and then reports an error ends disabled, by a conditional disable that is read back', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const h = harness({ failStatus: 'active', commitOnFail: true });
    await expect(open(h)).rejects.toThrow('replay-discovery: registration active failed: boom'); // the original error
    expect(h.world.status).toBe('disabled');
    // The disable is conditional on the status, scoped to the replay registration, and verified by a read.
    expect(h.log).toContain(`${REGISTRATION}.status=active`);
    expect(h.log.filter((e) => e === `${REGISTRATION}.ms_tenant_id=replay`).length).toBe(2); // the activation and the disable
    expect(h.log.indexOf(READBACK)).toBeGreaterThan(h.log.indexOf(`${REGISTRATION}:disabled`));
    // Nothing was polled, and the only writes are the registration's own.
    expect(h.log.some((e) => e.startsWith('mailbox_'))).toBe(false);
    expect(h.writes.every((w) => w.table === REGISTRATION && w.op === 'update')).toBe(true);
    expect(h.signals.listenerCount('SIGINT')).toBe(0);
  });

  it('an activation that never landed is not disturbed: the conditional disable matches nothing, and the error is still the original', async () => {
    const h = harness({ failStatus: 'active' });
    await expect(open(h)).rejects.toThrow(/registration active failed: boom/);
    expect(h.world.status).toBe('disabled');
    expect(disables(h)).toHaveLength(1);
  });

  it('retries the disable a bounded number of times, and still reports the original error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const h = harness({ failStatus: 'active', commitOnFail: true, disableFailures: 2 });
    await expect(open(h)).rejects.toThrow(/registration active failed: boom/);
    expect(h.world.status).toBe('disabled'); // the third attempt landed
    expect(disables(h)).toHaveLength(3);
  });

  it('gives up after the bound, says how to fix it, and still reports the original error', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const h = harness({ failStatus: 'active', commitOnFail: true, disableFailures: 99 });
    await expect(open(h)).rejects.toThrow(/registration active failed: boom/);
    expect(h.world.status).toBe('active'); // it could not be restored, and the operator is told
    expect(disables(h)).toHaveLength(3);
    expect(error.mock.calls.flat().join('\n')).toContain('README.md');
    expect(error.mock.calls.flat().join('\n')).not.toContain(TENANT);
  });
});

describe('openOptinWindow: what the operator is told', () => {
  it('lists each seated owner with no open consent, with the mailbox address and the /profile URL, and not the one who opted in', async () => {
    const h = harness({
      consented: new Set([INVITE_B]),
      onPoll: (poll) => poll === 2 && h.world.consented.add(INVITE_A),
    });
    await open(h);
    const text = h.lines.join('\n');
    expect(text).toContain('owner 1: a@bank.example opens http://localhost:3000/profile');
    expect(text).not.toContain('b@bank.example'); // already opted in: not listed
    expect(text).toContain('owner 1: opted in');
    expect(text).not.toMatch(/subject|body/i);
    // The window names its way out and its length.
    expect(text).toMatch(/Enter/);
    expect(text).toMatch(/Ctrl-C/);
  });

  it('does not offer Enter when there is no stdin to read it from', async () => {
    const h = harness();
    await open(h, { timeoutMs: 20, stdin: null });
    expect(h.lines.join('\n')).not.toMatch(/Enter/);
  });
});

describe('the --activate-for-optin inputs', () => {
  it.each([
    ['http://localhost:3000', 'http://localhost:3000/profile'],
    ['http://localhost:3000/', 'http://localhost:3000/profile'],
    ['https://app.example.test/some/path?x=1', 'https://app.example.test/profile'],
  ])('the profile URL of %s is %s (the origin, no network call)', (appUrl, expected) => {
    expect(optinProfileUrl(appUrl)).toBe(expected);
  });

  it('refuses an app URL that is not http(s)', () => {
    expect(() => optinProfileUrl('not a url')).toThrow(/--app-url/);
    expect(() => optinProfileUrl('ftp://localhost')).toThrow(/--app-url/);
  });

  it('--optin-timeout is whole seconds, default ten minutes', () => {
    expect(parseOptinTimeoutSeconds(null)).toBe(600);
    expect(parseOptinTimeoutSeconds('90')).toBe(90);
    for (const bad of ['0', '-5', '1.5', '10m', '', 'abc', '86401']) {
      expect(() => parseOptinTimeoutSeconds(bad)).toThrow(/--optin-timeout/);
    }
  });
});

describe('assertOptinTarget: the window is opened on a local stack only', () => {
  it.each(['http://127.0.0.1:54321', 'http://localhost:54321', 'http://[::1]:54321'])('accepts %s', (url) => {
    expect(() => assertOptinTarget(url)).not.toThrow();
  });

  it('refuses any other host, even one --allow-remote-supabase names', () => {
    expect(() => assertOptinTarget('https://t3.supabase.co')).toThrow(/--activate-for-optin.*local/);
    expect(() => assertOptinTarget('http://127.0.0.1.nip.io')).toThrow(/--activate-for-optin/);
  });
});

describe('the script never acts as an owner (static)', () => {
  const source = readFileSync(resolve(__dirname, '../../scripts/m365/replay-discovery.ts'), 'utf8');

  it.each([
    ['the consent RPCs', /mailbox_consent_(grant|withdraw)/],
    ['any rpc call', /\.rpc\s*\(/],
    ['a magic link or OTP', /generateLink|verifyOtp|magiclink|signInWith\w*|signIn\w*/i],
    ['any auth API at all', /\.auth\b|auth\.admin|createUser|getUserById|setSession/],
    ['the publishable key an owner session would use', /PUBLISHABLE_KEY|ANON_KEY/],
  ])('never references %s', (_name, pattern) => {
    expect(source).not.toMatch(pattern);
  });

  it('touches mailbox_consents only to read it', () => {
    const uses = source.match(/MAILBOX_CONSENTS|mailbox_consents/g) ?? [];
    const reads = source.match(/from\(TABLE\.MAILBOX_CONSENTS\)\s*\.select\(/g) ?? [];
    expect(uses.length).toBeGreaterThan(0);
    expect(reads.length).toBe(uses.length);
  });
});
