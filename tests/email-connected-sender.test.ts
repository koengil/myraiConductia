import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  GMAIL_MISCONFIGURED_COPY,
  GMAIL_RECONNECT_COPY,
  GMAIL_UNCONFIGURED_COPY,
  MAILBOX_CHANGED_COPY,
} from '../src/lib/constants/mailboxSend';
import {
  MailboxReadError,
  envelopeSha,
  sendAsConnectedUser,
  sendingIdentity,
  type SendingIdentity,
} from '../src/lib/email/connectedSender';
import { markRevoked } from '../src/lib/email/gmail';
import { encryptTokens } from '../src/lib/email/tokenCrypto';
import { OperatorCopyError, UpstreamHttpError } from '../src/lib/errors/upstream';
import { fakeGmailSend, invalidGrant, jsonResponse } from './helpers/fakeGmailSend';

/*
 * The connected-mailbox dispatcher (#490). Contracts under test:
 *   1. A read error throws MailboxReadError; it never reads as "no connection" (R21).
 *   2. The row must still be the identity read before the screen (expect, R17).
 *   3. No row -> null; Microsoft -> Graph, or null when Graph is unconfigured.
 *   4. Google never yields null: no config or an ended approval refuses before
 *      any Google call (M3, Q1); otherwise refresh, From pinned, messages.send.
 *   5. invalid_grant marks the row revoked, conditional on the blob it read,
 *      through one RPC that writes the change and its audit row together (R6,
 *      #490 audit 2).
 *   6. The envelope and the dispatch check bind the connection's row id, so a
 *      reconnect of the same address is a new mailbox (#490 audit 3).
 */

type Resp = { data: unknown; error: unknown };
type Call = { table: string; op: string; payload?: unknown; filters: Array<[string, unknown]> };

/**
 * A fake admin: each table, and each RPC as `rpc:<name>`, answers from a queue
 * (then { data: null }); every call and filter is recorded.
 */
function fakeAdmin(queue: Record<string, Resp[]> = {}) {
  const calls: Call[] = [];
  const rpc = (fn: string, args: unknown) => {
    calls.push({ table: `rpc:${fn}`, op: 'rpc', payload: args, filters: [] });
    return Promise.resolve(queue[`rpc:${fn}`]?.shift() ?? { data: null, error: null });
  };
  const from = (table: string) => {
    const call: Call = { table, op: 'select', filters: [] };
    calls.push(call);
    const next = () => Promise.resolve(queue[table]?.shift() ?? { data: null, error: null });
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = (column: string, value: unknown) => {
      call.filters.push([column, value]);
      return b;
    };
    b.update = (payload: unknown) => {
      Object.assign(call, { op: 'update', payload });
      return b;
    };
    b.insert = (payload: unknown) => {
      Object.assign(call, { op: 'insert', payload });
      return next();
    };
    b.maybeSingle = next;
    b.then = (f: (v: Resp) => unknown, r?: (e: unknown) => unknown) => next().then(f, r);
    return b;
  };
  return { admin: { from, rpc } as unknown as SupabaseClient, calls };
}

const KEY = 'a'.repeat(64);
const message = { to: ['founder@target.com'], bcc: ['records@bank.dev'], subject: 'Process update', text: 'The room opens Monday.' };

function configureGmail() {
  vi.stubEnv('GOOGLE_SEND_CLIENT_ID', 'send-client');
  vi.stubEnv('GOOGLE_SEND_CLIENT_SECRET', 'send-secret');
  vi.stubEnv('GOOGLE_SEND_REDIRECT_URI', 'http://localhost:3000/api/v1/mailbox/google/callback');
  vi.stubEnv('MAILBOX_TOKEN_KEY', KEY);
}

function googleRow(over: Record<string, unknown> = {}) {
  return {
    id: 'mb-g1',
    user_id: 'u1',
    provider: 'google',
    email: 'storm@bank.dev',
    status: 'connected',
    tokens_encrypted: encryptTokens({ refreshToken: 'rt-1' }),
    ...over,
  };
}

const identityOf = (row: { id: string; provider: string; email: string; status: string }): SendingIdentity => ({
  connectionId: row.id,
  provider: row.provider,
  email: row.email,
  status: row.status,
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('sendingIdentity', () => {
  it('throws on a read error, never null', async () => {
    const { admin } = fakeAdmin({ mailbox_connections: [{ data: null, error: { code: '57014', message: 'x' } }] });
    await expect(sendingIdentity(admin, 'u1')).rejects.toBeInstanceOf(MailboxReadError);
  });

  it('is null without a row, and carries no tokens with one', async () => {
    expect(await sendingIdentity(fakeAdmin().admin, 'u1')).toBeNull();
    vi.stubEnv('MAILBOX_TOKEN_KEY', KEY);
    const { admin, calls } = fakeAdmin({ mailbox_connections: [{ data: googleRow(), error: null }] });
    expect(await sendingIdentity(admin, 'u1')).toEqual({
      connectionId: 'mb-g1',
      provider: 'google',
      email: 'storm@bank.dev',
      status: 'connected',
    });
    expect(calls[0].filters).toEqual([['user_id', 'u1']]);
  });
});

describe('sendAsConnectedUser', () => {
  it('throws on a read error at dispatch, never null', async () => {
    const { admin } = fakeAdmin({ mailbox_connections: [{ data: null, error: { code: '57014', message: 'x' } }] });
    await expect(sendAsConnectedUser(admin, 'u1', message, { expect: null })).rejects.toBeInstanceOf(MailboxReadError);
  });

  it('returns null with no row, and for a Microsoft row when Graph is unconfigured', async () => {
    expect(await sendAsConnectedUser(fakeAdmin().admin, 'u1', message, { expect: null })).toBeNull();
    vi.stubEnv('MS_CLIENT_ID', '');
    const ms = { id: 'mb-m1', user_id: 'u1', provider: 'microsoft', email: 'storm@bank.dev', status: 'connected', tokens_encrypted: 'x' };
    const { admin } = fakeAdmin({ mailbox_connections: [{ data: ms, error: null }] });
    expect(await sendAsConnectedUser(admin, 'u1', message, { expect: identityOf(ms) })).toBeNull();
  });

  it('refuses when the mailbox changed since the identity read, in every direction', async () => {
    configureGmail();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const row = googleRow();
    const cases: Array<[Record<string, unknown> | null, SendingIdentity | null]> = [
      [row, null], // connected in between
      [null, identityOf(row)], // disconnected in between
      [{ ...row, provider: 'microsoft' }, identityOf(row)], // another provider
      [{ ...row, email: 'other@bank.dev' }, identityOf(row)], // another account
      [{ ...row, id: 'mb-g2' }, identityOf(row)], // the same address reconnected: a new row (#490 audit 3)
    ];
    for (const [data, expected] of cases) {
      const { admin } = fakeAdmin({ mailbox_connections: [{ data, error: null }] });
      const failure = await sendAsConnectedUser(admin, 'u1', message, { expect: expected }).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(OperatorCopyError);
      expect((failure as Error).message).toBe(MAILBOX_CHANGED_COPY);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a Google row with the sending client unconfigured throws, never null, and calls nobody', async () => {
    vi.stubEnv('MAILBOX_TOKEN_KEY', KEY);
    vi.stubEnv('GOOGLE_SEND_CLIENT_ID', '');
    // Graph configured: a Google row must still never reach Graph.
    vi.stubEnv('MS_CLIENT_ID', 'ms');
    vi.stubEnv('MS_CLIENT_SECRET', 'ms');
    vi.stubEnv('MS_REDIRECT_URI', 'http://localhost/cb');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const row = googleRow();
    const { admin } = fakeAdmin({ mailbox_connections: [{ data: row, error: null }] });
    const failure = await sendAsConnectedUser(admin, 'u1', message, { expect: identityOf(row) }).catch((e: unknown) => e);
    expect((failure as Error).message).toBe(GMAIL_UNCONFIGURED_COPY);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a revoked Google row refuses with the reconnect copy and no Google call', async () => {
    configureGmail();
    const gmail = fakeGmailSend();
    vi.stubGlobal('fetch', gmail.fetch);
    const row = googleRow({ status: 'revoked', tokens_encrypted: null });
    const { admin } = fakeAdmin({ mailbox_connections: [{ data: row, error: null }] });
    const failure = await sendAsConnectedUser(admin, 'u1', message, { expect: identityOf(row) }).catch((e: unknown) => e);
    expect((failure as Error).message).toBe(GMAIL_RECONNECT_COPY);
    expect(gmail.log).toEqual([]);
  });

  it('sends through Gmail with a fresh token and the From pinned to the connected address', async () => {
    configureGmail();
    const gmail = fakeGmailSend();
    vi.stubGlobal('fetch', gmail.fetch);
    const row = googleRow();
    const { admin } = fakeAdmin({
      mailbox_connections: [{ data: row, error: null }],
      users: [{ data: { display_name: 'Storm Duncan', full_name: null }, error: null }],
    });

    const receipt = await sendAsConnectedUser(admin, 'u1', message, { expect: identityOf(row) });

    expect(receipt).toEqual({ id: 'gmail-msg-1', provider: 'gmail' });
    expect(gmail.log).toEqual(['token', 'send']);
    expect(gmail.tokenCalls[0].get('grant_type')).toBe('refresh_token');
    expect(gmail.tokenCalls[0].get('refresh_token')).toBe('rt-1');
    expect(gmail.sends[0].authorization).toBe('Bearer at-fake');
    const sent = await gmail.parsed();
    expect(sent.from).toMatchObject({ name: 'Storm Duncan', address: 'storm@bank.dev' });
    expect(sent.bcc?.map((a) => a.address)).toEqual(['records@bank.dev']);
  });

  it('invalid_grant marks the row revoked against the blob it read, in one RPC with its audit row, and throws the reconnect copy', async () => {
    configureGmail();
    const gmail = fakeGmailSend({ token: invalidGrant });
    vi.stubGlobal('fetch', gmail.fetch);
    const row = googleRow();
    const { admin, calls } = fakeAdmin({
      mailbox_connections: [{ data: row, error: null }],
      'rpc:mailbox_sending_mark_revoked': [{ data: true, error: null }],
    });

    const failure = await sendAsConnectedUser(admin, 'u1', message, { expect: identityOf(row) }).catch((e: unknown) => e);

    expect((failure as Error).message).toBe(GMAIL_RECONNECT_COPY);
    expect(gmail.log).toEqual(['token']);
    const rpc = calls.filter((c) => c.op === 'rpc');
    expect(rpc).toEqual([
      expect.objectContaining({
        table: 'rpc:mailbox_sending_mark_revoked',
        payload: { p_connection: 'mb-g1', p_read_blob: row.tokens_encrypted },
      }),
    ]);
    // The state change and the audit row are the RPC's: no table write from TypeScript.
    expect(calls.some((c) => c.op === 'update' || c.table === 'audit_log')).toBe(false);
  });

  it('a refused client is operator copy and a 503 an upstream code; neither touches the row', async () => {
    configureGmail();
    const row = googleRow();
    for (const [reply, check] of [
      [() => jsonResponse({ error: 'invalid_client' }, 401), (e: unknown) => expect((e as Error).message).toBe(GMAIL_MISCONFIGURED_COPY)],
      [() => jsonResponse({ error: 'backendError' }, 503), (e: unknown) => expect(e).toMatchObject({ provider: 'gmail-token', status: 503 })],
    ] as const) {
      vi.stubGlobal('fetch', fakeGmailSend({ token: reply }).fetch);
      const { admin, calls } = fakeAdmin({ mailbox_connections: [{ data: row, error: null }] });
      const failure = await sendAsConnectedUser(admin, 'u1', message, { expect: identityOf(row) }).catch((e: unknown) => e);
      check(failure);
      expect(calls.some((c) => c.op === 'update' || c.op === 'rpc' || c.table === 'audit_log')).toBe(false);
    }
  });

  it('a Gmail send failure is an upstream code, and is not retried', async () => {
    configureGmail();
    const gmail = fakeGmailSend({ send: () => jsonResponse({ error: { code: 500, status: 'INTERNAL' } }, 500) });
    vi.stubGlobal('fetch', gmail.fetch);
    const row = googleRow();
    const { admin } = fakeAdmin({ mailbox_connections: [{ data: row, error: null }] });
    const failure = await sendAsConnectedUser(admin, 'u1', message, { expect: identityOf(row) }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(UpstreamHttpError);
    expect(failure).toMatchObject({ provider: 'gmail-send', status: 500 });
    expect(gmail.log).toEqual(['token', 'send']);
  });
});

describe('markRevoked', () => {
  it('is false when the conditional update changed nothing (a reconnect landed first)', async () => {
    const { admin, calls } = fakeAdmin({ 'rpc:mailbox_sending_mark_revoked': [{ data: false, error: null }] });
    expect(await markRevoked(admin, 'mb-g1', 'old-blob')).toBe(false);
    expect(calls.map((c) => c.table)).toEqual(['rpc:mailbox_sending_mark_revoked']);
  });

  it('is false, and logs only a code, when the RPC fails: the audit and the change are rolled back together', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { admin } = fakeAdmin({
      'rpc:mailbox_sending_mark_revoked': [{ data: null, error: { code: '23514', message: 'audit insert refused storm@bank.dev' } }],
    });
    expect(await markRevoked(admin, 'mb-g1', 'blob')).toBe(false);
    expect(JSON.stringify(logged.mock.calls)).toContain('23514');
    expect(JSON.stringify(logged.mock.calls)).not.toContain('storm@bank.dev');
  });
});

describe('envelopeSha', () => {
  const identity = { connectionId: 'mb-g1', provider: 'google', email: 'storm@bank.dev' };
  const base = { to: ['A@x.com'], cc: [], bcc: ['b@x.com'] };

  it('ignores case and padding, and changes with any recipient list or the mailbox', () => {
    const sha = envelopeSha(base, identity);
    expect(envelopeSha({ ...base, to: [' a@x.com '] }, identity)).toBe(sha);
    expect(envelopeSha({ ...base, bcc: [] }, identity)).not.toBe(sha);
    expect(envelopeSha({ ...base, cc: ['b@x.com'], bcc: [] }, identity)).not.toBe(sha);
    expect(envelopeSha(base, { ...identity, email: 'other@bank.dev' })).not.toBe(sha);
  });

  it('changes with the connection: a reconnect of the same address is a new envelope (#490 audit 3)', () => {
    expect(envelopeSha(base, { ...identity, connectionId: 'mb-g2' })).not.toBe(envelopeSha(base, identity));
  });
});
