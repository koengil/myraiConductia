import fs from 'node:fs';
import { join } from 'node:path';

import { costForUsage } from '../../src/lib/ai/pricing';
import { DEV_TENANT_ID } from '../../src/lib/db/tenant';
import { callModel, type ModelCallResult } from '../../src/lib/modelGateway';
import {
  isRetryableZdrRefusal,
  warnOnce,
  ZDR_REFUSED_MESSAGE,
  ZDR_RETRY_DELAYS_MS,
} from '../../src/lib/modelGateway/gatewayClient';
import { extractJsonPayload } from '../../src/lib/modelGateway/json';
import { assertProcessorAllowed, isSyntheticItem, ProcessorRefusedError } from '../../src/lib/modelGateway/processorGate';
import {
  MAX_NEW_NAME_CHARS,
  PROMPT_VERSION,
  PROPOSAL_PHASES,
  type DealProposalInput,
} from '../../src/lib/modelGateway/prompts/dealProposal.v2';
import { gatewayTransport } from '../../src/lib/modelGateway/transports';
import { DEMO_INTERNAL_DOMAINS, demoPipeline } from '../discovery/lib/demoPipeline';
import { assertRehearsalStack, type RehearsalEnv } from './stack';

/**
 * The #173 live ZDR probe (outline phase 3, design R8 "3c"). Owner-gated: nobody runs it in the rehearsal task, and
 * rehearse.sh never passes a gateway key, so it cannot run through the wrapper. The owner puts the key in a file only
 * they can read (never on a command line or in an env assignment, where `ps` would show it) and runs, by hand:
 *
 *   mkdir -p -m 700 ~/.config/conductia && install -m 600 /dev/null ~/.config/conductia/gateway.key && $EDITOR ~/.config/conductia/gateway.key
 *   env -i PATH="$PATH" HOME="$HOME" NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:57321 \
 *     DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:57322/postgres NEXT_PUBLIC_APP_ENV=dev \
 *     node --import tsx scripts/rehearsal/propose-live-probe.ts --confirm-live --key-file ~/.config/conductia/gateway.key
 *
 * The key file must be a regular file (not a symlink) owned by the caller, with no group or other permission bits
 * (key_file_mode); AI_GATEWAY_API_KEY in the environment is refused (key_in_env).
 *
 * It sends ONE committed synthetic corpus message that the firm rules leave unrouted, with the deal proposal prompt
 * (v2) and the pinned proposal model, through the one ZDR gateway client (gatewayTransport, whose body pins zero
 * retention and Anthropic only), on the ADR-0017 processor gate's synthetic path. It builds no database client and
 * writes nothing. A ZDR refusal ends the run (exit 1) and is never retried anywhere else; only the retryable
 * no_providers_available refusal is asked again, on D106's delays, so `fetch` runs 1 to 3 times. It prints one
 * line of integers and fixed codes, never the key, the reply or the message.
 *
 * Not proven here: proposeDeals' own retry and stop logic and the proposalGate flag lock (this file stays inside
 * PROPOSE_FENCE and makes the one call itself), the operator locks (it selects the transport itself), and the
 * verified path (G-13). Proposed: a narrower PROPOSE_FENCE exception that would let it run the real proposeDeals is
 * an owner decision (the ADR-0018 amendment, D91).
 */

export const PROBE = 'propose_live';

/**
 * The proposal model, pinned as src/lib/discovery/propose/model.ts PROPOSAL_MODEL is. That module is behind
 * PROPOSE_FENCE, so it is repeated here; tests/rehearsal/propose-live-probe.test.ts asserts the two are equal.
 */
export const PROBE_MODEL = 'anthropic/claude-haiku-5.5';

/** The most gateway requests the probe may make: one call, asked at most twice more (D106). */
export const MAX_FETCHES = 1 + ZDR_RETRY_DELAYS_MS.length;

/** The demo corpus's seeded mail, as the Graph fixture holds it (the Gmail twin is built from the same corpus). */
const DEMO_MAIL_DIR = 'tests/fixtures/discovery/demo/graph';
/** run.ts MAX_PARTY_DOMAINS: the prompt's participant domains are capped the same way. */
const MAX_DOMAINS = 100;

export type ProbeMessage = { messageId: string; contentHash: string; input: DealProposalInput };

export type ProbeDeps = {
  /** The wait before a retry; tests pass one that does not wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Where the one line goes. */
  print?: (line: string) => void;
  /** The message to send; tests pass a fixed one. */
  loadMessage?: () => ProbeMessage;
};

const CODE = /^[a-z_]+$/;
const KEY = /^[A-Za-z_]+$/;

/** The one line the probe prints: integers and [a-z_]+ codes, plus costUsd as a finite non-negative number. */
export function liveLine(fields: Record<string, number | string>): string {
  const out: Record<string, number | string> = { probe: PROBE };
  for (const [key, value] of Object.entries(fields)) {
    if (!KEY.test(key) || key === 'probe') throw new Error('liveLine: a key is not a plain name');
    const ok =
      typeof value === 'number'
        ? key === 'costUsd'
          ? Number.isFinite(value) && value >= 0
          : Number.isSafeInteger(value)
        : CODE.test(value);
    if (!ok) throw new Error(`liveLine: ${key} is not an integer or a code`);
    out[key] = value;
  }
  return JSON.stringify(out);
}

/** A fetch that counts its calls and refuses, without sending, any call past `max`. */
export function boundedFetch(fetchImpl: typeof fetch, max: number = MAX_FETCHES): { fetch: typeof fetch; count: () => number } {
  let calls = 0;
  const bounded: typeof fetch = async (input, init) => {
    calls++;
    if (calls > max) throw new Error('propose-live-probe: fetch bound reached');
    return fetchImpl(input, init);
  };
  return { fetch: bounded, count: () => calls };
}

/** Outside participant domains, as run.ts participantDomains builds them: never a local part or a display name. */
function outsideDomains(addresses: readonly string[]): string[] {
  const internal = new Set(DEMO_INTERNAL_DOMAINS);
  const domains = addresses
    .map((a) => a.slice(a.lastIndexOf('@') + 1).trim().toLowerCase())
    .filter((d) => /^[a-z0-9.-]+$/.test(d) && d.includes('.') && !internal.has(d));
  return [...new Set(domains)].sort().slice(0, MAX_DOMAINS);
}

/** The first (by Message-ID) committed synthetic message that the firm rules leave unrouted on the demo corpus. */
export function loadUnroutedSyntheticMessage(root: string = process.cwd()): ProbeMessage {
  const pick = demoPipeline(join(root, DEMO_MAIL_DIR))
    .routed.filter(
      (r) => r.routes.length === 0 && r.item.kind !== 'document' && isSyntheticItem(r.item.internetMessageId),
    )
    .sort((a, b) => a.item.internetMessageId.localeCompare(b.item.internetMessageId))[0];
  if (!pick) throw new ProbeRefusal('no_message', 3);
  const { item } = pick;
  return {
    messageId: item.internetMessageId,
    contentHash: item.contentHash,
    input: {
      subject: item.subject,
      sentAt: item.sentAt,
      body: item.bodyText, // the prompt cuts it
      domains: outsideDomains(item.participants.map((p) => p.address)),
      candidates: [], // no known deals: the probe reads no database
    },
  };
}

const PHASE_IDS: ReadonlySet<string> = new Set(PROPOSAL_PHASES.map((p) => p.id));
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isProbability = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;

/**
 * The reply's outcome, as parse.ts parseProposalReply would settle it with no known deals (that module is behind
 * PROPOSE_FENCE; the test checks the two agree). Only the outcome leaves this function.
 */
export function replyOutcome(text: string): 'deal' | 'not_deal' | 'invalid' {
  let data: unknown;
  try {
    data = JSON.parse(extractJsonPayload(text));
  } catch {
    return 'invalid';
  }
  if (!isObject(data)) return 'invalid';
  if (typeof data.deal_related !== 'boolean' || !isProbability(data.p_deal) || !isProbability(data.p_phase)) return 'invalid';
  const deal = data.deal;
  const dealOk =
    deal === null ||
    (isObject(deal) &&
      Object.keys(deal).length === 1 &&
      typeof deal.new_name === 'string' &&
      deal.new_name.trim().length > 0 &&
      deal.new_name.trim().length <= MAX_NEW_NAME_CHARS);
  const phaseOk = data.phase === null || (typeof data.phase === 'string' && PHASE_IDS.has(data.phase));
  if (!dealOk || !phaseOk) return 'invalid';
  if (!data.deal_related) return 'not_deal';
  return deal !== null && data.phase !== null ? 'deal' : 'invalid';
}

/** A refusal before anything is sent: a fixed code and its exit status. */
class ProbeRefusal extends Error {
  constructor(
    readonly code: string,
    readonly exit: number,
  ) {
    super(code);
  }
}

/**
 * The gateway key from an owner-only file: a regular file (lstat, so not a symlink), owned by this user, with no
 * group or other permission bits (key_file_mode, exit 2). A missing or blank file is no_key (exit 3). Its contents
 * are never printed.
 */
function readKeyFile(file: string): string {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) throw new ProbeRefusal('no_key', 3);
  const owner = typeof process.getuid === 'function' ? process.getuid() : stat.uid;
  if (!stat.isFile() || stat.uid !== owner || (stat.mode & 0o077) !== 0) throw new ProbeRefusal('key_file_mode', 2);
  const key = fs.readFileSync(file, 'utf8').trim();
  if (!key) throw new ProbeRefusal('no_key', 3);
  return key;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Exit 0 on an answered call; 1 on a failed call (a ZDR refusal included) or anything unexpected; 2 on a refusal
 * before anything is built; 3 on no key, no message, or a request count outside [1, MAX_FETCHES].
 */
export async function main(
  argv: readonly string[],
  env: RehearsalEnv = process.env,
  fetchImpl: typeof fetch = fetch,
  deps: ProbeDeps = {},
): Promise<number> {
  const print = deps.print ?? ((line: string) => console.log(line));
  try {
    try {
      assertRehearsalStack('propose-live-probe', env);
    } catch (error) {
      // The guard's message names host:port only (stack.ts).
      console.error(error instanceof Error ? error.message : 'refused');
      throw new ProbeRefusal('stack_mismatch', 2);
    }
    if (env.NEXT_PUBLIC_APP_ENV === 'prod') throw new ProbeRefusal('prod', 2);
    if (!argv.includes('--confirm-live')) throw new ProbeRefusal('not_confirmed', 2);
    if (argv.length !== 3 || argv[0] !== '--confirm-live' || argv[1] !== '--key-file' || !argv[2]) {
      throw new ProbeRefusal('usage', 2);
    }
    const keyFile = argv[2];
    // A key in the environment came from an env assignment or an export, both visible to other processes.
    if (env.AI_GATEWAY_API_KEY !== undefined) throw new ProbeRefusal('key_in_env', 2);
    // The processor gate's synthetic path for the DEV tenant, with the gateway transport this probe selects itself.
    let path: string;
    try {
      path = assertProcessorAllowed(DEV_TENANT_ID, 'gateway', { ...env, DISCOVERY_EXTRACT_TRANSPORT: 'gateway' });
    } catch (error) {
      if (error instanceof ProcessorRefusedError) throw new ProbeRefusal(CODE.test(error.why) ? error.why : 'processor_refused', 2);
      throw error;
    }
    if (path !== 'synthetic') throw new ProbeRefusal('not_synthetic', 2);
    const apiKey = readKeyFile(keyFile); // before any transport or message is built

    const message = (deps.loadMessage ?? loadUnroutedSyntheticMessage)();
    if (!isSyntheticItem(message.messageId)) throw new ProbeRefusal('not_synthetic', 2);
    const counted = boundedFetch(fetchImpl);
    const transport = gatewayTransport({ apiKey, fetchImpl: counted.fetch });
    const sleep = deps.sleep ?? wait;
    const send = () =>
      callModel(
        {
          purpose: 'deal_proposal',
          promptVersion: PROMPT_VERSION,
          model: PROBE_MODEL,
          tenantId: DEV_TENANT_ID,
          contentHash: message.contentHash,
          input: message.input,
        },
        transport,
      );

    const called = 1; // one message, asked once (its retries are the same call)
    let call: ModelCallResult = await send();
    // D106: only a no_providers_available refusal is asked again; a 403 ZDR refusal (D90) and any other failure stop.
    for (let attempt = 1; !call.ok && isRetryableZdrRefusal(call) && attempt <= ZDR_RETRY_DELAYS_MS.length; attempt++) {
      await sleep(ZDR_RETRY_DELAYS_MS[attempt - 1]);
      call = await send();
    }
    if (!call.ok && call.code === 'zdr_unavailable') warnOnce('rehearsal_propose_live', ZDR_REFUSED_MESSAGE);

    const fetches = counted.count();
    const costUsd =
      call.ok && call.usage
        ? Math.round((costForUsage(call.usage.model.replace(/^anthropic\//, ''), call.usage) ?? 0) * 1_000_000) / 1_000_000
        : 0;
    const fields: Record<string, number | string> = {
      called,
      fetches,
      outcome: call.ok ? replyOutcome(call.text) : 'failed',
      failedCode: call.ok ? 'none' : call.code,
      stopReason: call.ok ? 'none' : call.code === 'zdr_unavailable' ? 'zdr_unavailable' : 'failed',
      costUsd,
    };
    if (!call.ok && call.zdrReason) fields.zdrReason = call.zdrReason;
    if (fetches < 1 || fetches > MAX_FETCHES) {
      print(liveLine({ ...fields, code: 'no_gateway_call' }));
      return 3;
    }
    print(liveLine(fields));
    return call.ok ? 0 : 1;
  } catch (error) {
    if (error instanceof ProbeRefusal) {
      print(liveLine({ code: error.code }));
      return error.exit;
    }
    // Never a message or a stack: a fixed code only.
    print(liveLine({ code: 'unexpected' }));
    return 1;
  }
}

if (process.argv[1]?.endsWith('propose-live-probe.ts')) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.exitCode = 1;
    },
  );
}
