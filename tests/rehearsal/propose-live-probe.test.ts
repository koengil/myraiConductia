// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PROPOSAL_MODEL } from '@/lib/discovery/propose/model';
import { parseProposalReply } from '@/lib/discovery/propose/parse';
import { __resetWarnOnceForTests, ZDR_RETRY_DELAYS_MS } from '@/lib/modelGateway/gatewayClient';
import { isSyntheticItem } from '@/lib/modelGateway/processorGate';
import { SYNTHETIC_MESSAGE_IDS } from '@/lib/modelGateway/syntheticCorpus.generated';

import {
  boundedFetch,
  liveLine,
  loadUnroutedSyntheticMessage,
  main,
  MAX_FETCHES,
  PROBE_MODEL,
  replyOutcome,
  type ProbeMessage,
} from '../../scripts/rehearsal/propose-live-probe';

// #173 phase 3: the owner-gated live ZDR probe, run offline against a fake fetch. No key is real, nothing is sent.

const KEY = 'probe-canary-key-not-real';
// The key comes from an owner-only file (audit item 13), never from the environment or the command line.
const KEY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'live-probe-'));
afterAll(() => fs.rmSync(KEY_DIR, { recursive: true, force: true }));
function keyFile(name: string, text: string, mode = 0o600): string {
  const file = path.join(KEY_DIR, name);
  fs.writeFileSync(file, text, { mode });
  fs.chmodSync(file, mode);
  return file;
}
const KEY_FILE = keyFile('gateway.key', `${KEY}\n`);
const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:57321',
  DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:57322/postgres',
  NEXT_PUBLIC_APP_ENV: 'dev',
};
const CONFIRM = ['--confirm-live', '--key-file', KEY_FILE];

const DEAL_REPLY = JSON.stringify({ deal_related: true, p_deal: 0.9, deal: { new_name: 'Probe Deal' }, phase: 'phase-2', p_phase: 0.7 });
const answered = (text = DEAL_REPLY) =>
  new Response(
    JSON.stringify({
      id: 'msg_probe',
      model: 'claude-haiku-5.5',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 1200, output_tokens: 40 },
    }),
    { status: 200 },
  );
const refusal = (status: number, type: string, message: string) =>
  new Response(JSON.stringify({ type: 'error', error: { type, message } }), { status });
const NO_PROVIDERS = () => refusal(400, 'no_providers_available', 'No ZDR (Zero Data Retention) providers available');
const PLAN_NO_ZDR = () => refusal(403, 'permission_denied', 'Zero Data Retention (ZDR) is only available for Pro and Enterprise plans');

const FIXED_MESSAGE: ProbeMessage = {
  messageId: [...SYNTHETIC_MESSAGE_IDS][0],
  contentHash: 'sha256:probe',
  input: { subject: 's', sentAt: null, body: 'b', domains: [], candidates: [] },
};

/** A gateway that answers each request with the next reply; the last one repeats. */
function gateway(...replies: Array<() => Response>) {
  let i = 0;
  return vi.fn<typeof fetch>(async () => replies[Math.min(i++, replies.length - 1)]());
}

async function run(
  argv: string[],
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch,
  loadMessage: () => ProbeMessage = vi.fn(() => FIXED_MESSAGE),
) {
  const lines: string[] = [];
  const sleep = vi.fn<(ms: number) => Promise<void>>(async () => undefined);
  const code = await main(argv, env, fetchImpl, { print: (l) => lines.push(l), sleep, loadMessage });
  return { code, lines, sleep, loadMessage, line: lines.length === 1 ? (JSON.parse(lines[0]) as Record<string, unknown>) : null };
}

beforeEach(() => {
  __resetWarnOnceForTests();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('the pinned model', () => {
  it('is the proposal step pin (PROPOSAL_MODEL), repeated because propose/model.ts is behind PROPOSE_FENCE', () => {
    expect(PROBE_MODEL).toBe(PROPOSAL_MODEL);
  });

  it('is the model the request carries', async () => {
    const fetchImpl = gateway(() => answered());
    await run(CONFIRM, ENV, fetchImpl);
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body)).model).toBe(PROPOSAL_MODEL);
  });
});

describe('refusals before anything is built', () => {
  it.each([
    ['no environment at all (the bare env -i check)', {}],
    ['the shared 54321 stack', { ...ENV, NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321' }],
    ['the shared 54322 database', { ...ENV, DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres' }],
    ['a hosted API', { ...ENV, NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co' }],
  ])('refuses at the stack pin: %s', async (_, env) => {
    const fetchImpl = gateway(() => answered());
    const r = await run(CONFIRM, env, fetchImpl);
    expect(r.code).toBe(2);
    expect(r.line).toEqual({ probe: 'propose_live', code: 'stack_mismatch' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r.loadMessage).not.toHaveBeenCalled();
  });

  it.each([
    ['prod', { ...ENV, NEXT_PUBLIC_APP_ENV: 'prod' }, CONFIRM],
    ['not_confirmed', ENV, []],
    ['not_confirmed', ENV, ['--yes']],
    ['not_confirmed', ENV, ['--key-file', KEY_FILE]],
    ['usage', ENV, ['--confirm-live']],
    ['usage', ENV, ['--confirm-live', '--key-file']],
    ['usage', ENV, ['--confirm-live', '--tenant', 'other']],
    ['key_in_env', { ...ENV, AI_GATEWAY_API_KEY: KEY }, CONFIRM],
  ])('refuses with %s', async (code, env, argv) => {
    const fetchImpl = gateway(() => answered());
    const r = await run(argv, env, fetchImpl);
    expect(r.code).toBe(2);
    expect(r.line).toEqual({ probe: 'propose_live', code });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r.loadMessage).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', () => path.join(KEY_DIR, 'absent.key')],
    ['blank', () => keyFile('blank.key', '  \n')],
  ])('exits 3 no_key, before a message is loaded or a request built, when the key file is %s', async (_, file) => {
    const fetchImpl = gateway(() => answered());
    const r = await run(['--confirm-live', '--key-file', file()], ENV, fetchImpl);
    expect(r.code).toBe(3);
    expect(r.line).toEqual({ probe: 'propose_live', code: 'no_key' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r.loadMessage).not.toHaveBeenCalled();
  });

  it.each([
    ['readable by the group', () => keyFile('group.key', KEY, 0o640)],
    ['readable by anyone', () => keyFile('world.key', KEY, 0o644)],
    ['a symlink to an owner-only file', () => {
      const link = path.join(KEY_DIR, `link-${Math.random().toString(36).slice(2)}.key`);
      fs.symlinkSync(KEY_FILE, link);
      return link;
    }],
    ['a directory', () => fs.mkdtempSync(path.join(KEY_DIR, 'dir-'))],
  ])('refuses key_file_mode when the key file is %s, before reading it', async (_, file) => {
    const fetchImpl = gateway(() => answered());
    const r = await run(['--confirm-live', '--key-file', file()], ENV, fetchImpl);
    expect(r.code).toBe(2);
    expect(r.line).toEqual({ probe: 'propose_live', code: 'key_file_mode' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r.loadMessage).not.toHaveBeenCalled();
  });

  it('refuses a message outside the committed synthetic corpus', async () => {
    const fetchImpl = gateway(() => answered());
    const r = await run(CONFIRM, ENV, fetchImpl, vi.fn(() => ({ ...FIXED_MESSAGE, messageId: '<real-mail@firm.example>' })));
    expect(r.code).toBe(2);
    expect(r.line).toEqual({ probe: 'propose_live', code: 'not_synthetic' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('one call through the ZDR gateway client', () => {
  it('answers: one fetch, exit 0, one line of counts and codes with the cost', async () => {
    const fetchImpl = gateway(() => answered());
    const r = await run(CONFIRM, ENV, fetchImpl);
    expect(r.code).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(r.lines).toHaveLength(1);
    expect(r.line).toMatchObject({ probe: 'propose_live', called: 1, fetches: 1, outcome: 'deal', failedCode: 'none', stopReason: 'none' });
    expect(r.line?.costUsd).toBeGreaterThan(0);
    expect(r.lines[0]).not.toContain(KEY);
    expect(r.lines[0]).not.toContain('Probe Deal');
  });

  it('a 403 ZDR refusal is never retried (D90): one fetch, exit 1', async () => {
    const fetchImpl = gateway(PLAN_NO_ZDR);
    const r = await run(CONFIRM, ENV, fetchImpl);
    expect(r.code).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(r.sleep).not.toHaveBeenCalled();
    expect(r.line).toMatchObject({ fetches: 1, outcome: 'failed', failedCode: 'zdr_unavailable', stopReason: 'zdr_unavailable', zdrReason: 'permission_denied', costUsd: 0 });
  });

  it('a lasting no_providers_available refusal is asked twice more on D106 delays, then ends the run: three fetches, exit 1', async () => {
    const fetchImpl = gateway(NO_PROVIDERS);
    const r = await run(CONFIRM, ENV, fetchImpl);
    expect(r.code).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(MAX_FETCHES);
    expect(MAX_FETCHES).toBe(3);
    expect(r.sleep.mock.calls.map(([ms]) => ms)).toEqual([...ZDR_RETRY_DELAYS_MS]);
    expect(r.line).toMatchObject({ called: 1, fetches: 3, stopReason: 'zdr_unavailable', zdrReason: 'no_providers_available' });
  });

  it('a passing no_providers_available gap is asked again and answers: two fetches, exit 0', async () => {
    const fetchImpl = gateway(NO_PROVIDERS, () => answered());
    const r = await run(CONFIRM, ENV, fetchImpl);
    expect(r.code).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(r.line).toMatchObject({ fetches: 2, outcome: 'deal' });
  });

  it.each([
    ['a 500', () => new Response('{}', { status: 500 })],
    ['a 400 that is not a ZDR refusal', () => refusal(400, 'invalid_request_error', 'bad')],
  ])('%s is not retried: one fetch, exit 1, failedCode http', async (_, reply) => {
    const fetchImpl = gateway(reply);
    const r = await run(CONFIRM, ENV, fetchImpl);
    expect(r.code).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(r.line).toMatchObject({ fetches: 1, outcome: 'failed', failedCode: 'http', stopReason: 'failed' });
  });

  it('a thrown fetch is a failed call, never a stack', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error('connect ECONNREFUSED with detail');
    });
    const r = await run(CONFIRM, ENV, fetchImpl);
    expect(r.code).toBe(1);
    expect(r.lines[0]).not.toContain('ECONNREFUSED');
    expect(r.line).toMatchObject({ fetches: 1, failedCode: 'http' });
  });

  it('an unexpected error prints a fixed code only', async () => {
    const r = await run(CONFIRM, ENV, gateway(() => answered()), vi.fn((): ProbeMessage => {
      throw new Error('fixture detail that must not print');
    }));
    expect(r.code).toBe(1);
    expect(r.lines).toEqual(['{"probe":"propose_live","code":"unexpected"}']);
  });

  it('a reply that does not parse is counted invalid, not printed', async () => {
    const r = await run(CONFIRM, ENV, gateway(() => answered('Sure, here is my answer about the email.')));
    expect(r.code).toBe(0);
    expect(r.line).toMatchObject({ outcome: 'invalid' });
    expect(r.lines[0]).not.toContain('Sure');
  });
});

describe('boundedFetch', () => {
  it('counts calls and refuses, without sending, any past the bound', async () => {
    const inner = vi.fn<typeof fetch>(async () => new Response('{}'));
    const bounded = boundedFetch(inner, 3);
    for (let i = 0; i < 3; i++) await bounded.fetch('http://x.invalid');
    await expect(bounded.fetch('http://x.invalid')).rejects.toThrow('fetch bound reached');
    expect(inner).toHaveBeenCalledTimes(3);
    expect(bounded.count()).toBe(4);
  });
});

describe('replyOutcome agrees with parseProposalReply (no known deals)', () => {
  const settle = (text: string) => {
    const parsed = parseProposalReply(text, []);
    if (!parsed.ok) return 'invalid';
    return parsed.reply.deal_related ? 'deal' : 'not_deal';
  };
  it.each([
    DEAL_REPLY,
    JSON.stringify({ deal_related: false, p_deal: 0.1, deal: null, phase: null, p_phase: 0 }),
    JSON.stringify({ deal_related: false, p_deal: 0.1, deal: { new_name: 'X' }, phase: 'phase-1', p_phase: 0.2 }),
    JSON.stringify({ deal_related: true, p_deal: 0.9, deal: null, phase: 'phase-2', p_phase: 0.5 }),
    JSON.stringify({ deal_related: true, p_deal: 0.9, deal: { new_name: 'X' }, phase: null, p_phase: 0 }),
    JSON.stringify({ deal_related: true, p_deal: 0.9, deal: { ref: 'c:1' }, phase: 'phase-2', p_phase: 0.5 }),
    JSON.stringify({ deal_related: true, p_deal: 1.5, deal: { new_name: 'X' }, phase: 'phase-2', p_phase: 0.5 }),
    JSON.stringify({ deal_related: true, p_deal: 0.9, deal: { new_name: ' ' }, phase: 'phase-2', p_phase: 0.5 }),
    JSON.stringify({ deal_related: true, p_deal: 0.9, deal: { new_name: 'x'.repeat(81) }, phase: 'phase-2', p_phase: 0.5 }),
    JSON.stringify({ deal_related: true, p_deal: 0.9, deal: { new_name: 'X' }, phase: 'phase-9', p_phase: 0.5 }),
    JSON.stringify({ deal_related: 'yes', p_deal: 0.9, deal: null, phase: null, p_phase: 0 }),
    `\`\`\`json\n${DEAL_REPLY}\n\`\`\``,
    '[]',
    'not json',
    '',
  ])('%s', (text) => {
    expect(replyOutcome(text)).toBe(settle(text));
  });
});

describe('the message it sends', () => {
  it('is one committed synthetic corpus message the firm rules leave unrouted, chosen the same way every run', () => {
    const a = loadUnroutedSyntheticMessage();
    const b = loadUnroutedSyntheticMessage();
    expect(isSyntheticItem(a.messageId)).toBe(true);
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.input.candidates).toEqual([]);
    for (const domain of a.input.domains) expect(domain).toMatch(/^[a-z0-9.-]+\.[a-z0-9-]+$/);
  });
});

describe('liveLine', () => {
  it('prints integers, codes and a cost; refuses anything else', () => {
    expect(liveLine({ called: 1, code: 'no_key', costUsd: 0.000123 })).toBe('{"probe":"propose_live","called":1,"code":"no_key","costUsd":0.000123}');
    expect(() => liveLine({ outcome: 'Probe Deal' })).toThrow('liveLine: outcome is not an integer or a code');
    expect(() => liveLine({ fetches: 1.5 })).toThrow();
    expect(() => liveLine({ costUsd: -1 })).toThrow();
    expect(() => liveLine({ probe: 'other' })).toThrow();
  });
});
