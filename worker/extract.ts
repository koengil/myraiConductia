// The deal-zone process (design R8): selects allowed, firm-routed items, sends
// each through the model gateway (recorded replies by default, R19), stores
// events, and assesses candidates with the pure stage engine. It never imports
// @/lib/mailboxAccess or a reader, so fence D and the boot-claim test hold, and
// it reads stored text only through discovery_extract_batch. It is not a
// classification file, so fence B (no model in the classification zone) does
// not apply to it.
//
//   node --import tsx worker/extract.ts [--once | --watch | --serve] [--transport recorded|gateway]
//        [--replies <file>] [--tenant <uuid>] [--strict]
//   node --import tsx worker/extract.ts --estimate [--tenant <uuid>]
//   node --import tsx worker/extract.ts --rules [--tenant <uuid>]
//
// --once is the default; --serve (the image's entrypoint flag) is --watch;
// --tenant defaults to DEV_TENANT_ID. --estimate is a dry run that runs alone: it
// prints one JSON line of statistics and the expected cost of what a live pass
// would send, builds no transport and calls no model (#261). The environment
// is passed explicitly by the runbook (no --env-file): NEXT_PUBLIC_SUPABASE_URL
// and SUPABASE_SECRET_KEY, plus DISCOVERY_EXTRACT_TRANSPORT=gateway and
// AI_GATEWAY_API_KEY for a live synthetic call (processorGate.ts decides). A gateway pass is
// bounded by its own estimate (#261): it opens a budget over a fixed cohort, prints
// {"estimate":...} once, checks every call's ceiling cost against the stop line, and stops
// ("capped") on unpriced or unrecorded usage. A stopped pass still answers corrections.
// --rules is the rule detector's run (#173 G-07 slice 3b, the image's `detect` entry), and it runs alone: it builds
// no transport and asks no processor gate, loads the tenant's milestone_rules approvals first (a read error counts as
// none), reads no mail without one (it only drains the recompute outbox), and prints one JSON line of integers and
// fixed codes, never a sentence.
// SIGTERM or SIGINT (an ECS stop, a deploy) ends the pass between items and exits 0: a call
// in hand is finished, put on record and settled first, so a stop does not strand its reservation.
// A stop during a ZDR retry's wait ends the wait; the refusal is settled as the last attempt (exit 1).

import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { TENANT_CAPABILITY } from '@/lib/constants/discovery';
import { DEV_TENANT_ID } from '@/lib/db/tenant';
import { runDetectOnce, type DetectSummary } from '@/lib/discovery/detect/run';
import { supabaseDetectStore, type DetectStore } from '@/lib/discovery/detect/store';
import { estimateOnce } from '@/lib/discovery/extract/estimate';
import { runExtractOnce, type AssessStore, type ExtractStore, type ExtractSummary } from '@/lib/discovery/extract/run';
import { supabaseExtractStore } from '@/lib/discovery/extract/store';
import { loadTenantApprovals } from '@/lib/discovery/tenantApprovals';
import { OperatorCopyError, errorCodeOf } from '@/lib/errors/upstream';
import { loadRecording, recordedTransport } from '@/lib/modelGateway/record';
import { gatewayTransport, type ModelTransport } from '@/lib/modelGateway/transports';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const DEFAULT_REPLIES = 'tests/fixtures/discovery/demo/model-replies/extract.v1.json';
/** What stands in for the owner's recording until it is committed (the same fallback as e2e/support/recording.ts). */
export const STUB_REPLIES = 'tests/fixtures/discovery/demo/model-replies/extract.v1.stub.json';
const WATCH_INTERVAL_MS = 3000;

export type ExtractArgs = {
  watch: boolean;
  strict: boolean;
  transport: 'recorded' | 'gateway';
  replies: string | null;
  tenant: string;
  estimate: boolean;
  rules: boolean;
};

export function parseExtractArgs(argv: string[]): ExtractArgs {
  const valueOf = (flag: string): string | null => {
    const at = argv.indexOf(flag);
    if (at < 0) return null;
    const value = argv[at + 1];
    if (!value || value.startsWith('--')) throw new OperatorCopyError(`${flag} needs a value`);
    return value;
  };
  const transport = valueOf('--transport') ?? 'recorded';
  if (transport !== 'recorded' && transport !== 'gateway') {
    throw new OperatorCopyError('--transport must be "recorded" or "gateway"');
  }
  const watch = argv.includes('--watch') || argv.includes('--serve');
  if (argv.includes('--once') && watch) throw new OperatorCopyError('--once and --watch exclude each other');
  const tenant = valueOf('--tenant') ?? DEV_TENANT_ID;
  if (!UUID.test(tenant)) throw new OperatorCopyError('--tenant must be a lowercase uuid');
  const estimate = argv.includes('--estimate');
  if (estimate && (watch || argv.includes('--once') || argv.includes('--transport') || argv.includes('--replies'))) {
    throw new OperatorCopyError('--estimate runs alone: no --once, --watch, --transport or --replies');
  }
  const rules = argv.includes('--rules');
  if (rules && (estimate || watch || argv.includes('--once') || argv.includes('--transport') || argv.includes('--replies') || argv.includes('--strict'))) {
    throw new OperatorCopyError('--rules runs alone: no --estimate, --once, --watch, --transport, --replies or --strict');
  }
  return {
    watch,
    strict: argv.includes('--strict'),
    transport,
    replies: valueOf('--replies'),
    tenant,
    estimate,
    rules,
  };
}

export function serviceClientFromEnv(env: NodeJS.ProcessEnv = process.env): SupabaseClient {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new OperatorCopyError('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY must be set');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export type RepliesChoice = { path: string; kind: 'named' | 'recording' | 'stub' };

/**
 * Which replies file a recorded run reads. A file named with --replies is used as given, never replaced.
 * Otherwise the owner's recording, and the stub when the recording is not committed yet.
 */
export function chooseRepliesFile(named: string | null, exists: (path: string) => boolean = existsSync): RepliesChoice {
  if (named) {
    if (!exists(named)) throw new OperatorCopyError(`no recorded replies at ${named}: pass --replies <file>, or record them (scripts/discovery/record-extract-replies.ts)`);
    return { path: named, kind: 'named' };
  }
  if (exists(DEFAULT_REPLIES)) return { path: DEFAULT_REPLIES, kind: 'recording' };
  if (exists(STUB_REPLIES)) return { path: STUB_REPLIES, kind: 'stub' };
  throw new OperatorCopyError(`no recorded replies at ${DEFAULT_REPLIES} or ${STUB_REPLIES}: pass --replies <file>, or record them (scripts/discovery/record-extract-replies.ts)`);
}

function transportFor(args: ExtractArgs): ModelTransport {
  if (args.transport === 'gateway') return gatewayTransport();
  const chosen = chooseRepliesFile(args.replies);
  console.error(`extract: replaying ${chosen.kind} replies from ${chosen.path}`); // the path only, never content
  return recordedTransport(loadRecording(chosen.path));
}

export type MainDeps = {
  transportFor: (args: ExtractArgs) => ModelTransport;
  store: () => ExtractStore;
  print: (line: string) => void;
  /** Registers what stops the worker; the default is SIGTERM and SIGINT. Tests call `stop` themselves. */
  onStop?: (stop: () => void) => void;
  /** Tests only: the wait before a ZDR refusal is asked again (#625). */
  sleep?: (ms: number) => Promise<void>;
  /** The --rules run's store and approvals (#173 G-07 slice 3b); the default is the service-role client's. */
  rules?: () => { store: DetectStore & AssessStore; approvedFirms: (tenantId: string) => Promise<string[]> };
};
const DEFAULT_DEPS: MainDeps = {
  transportFor,
  store: () => supabaseExtractStore(serviceClientFromEnv()),
  print: (line) => console.log(line),
  onStop: (stop) => {
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  },
  rules: () => {
    const db = serviceClientFromEnv();
    return {
      store: { ...supabaseExtractStore(db), ...supabaseDetectStore(db) },
      approvedFirms: (tenantId) => loadTenantApprovals(db, tenantId, TENANT_CAPABILITY.MILESTONE_RULES),
    };
  },
};

export async function main(argv: string[] = process.argv.slice(2), deps: MainDeps = DEFAULT_DEPS): Promise<void> {
  const args = parseExtractArgs(argv);
  if (args.rules) {
    // No transport is built and no processor gate is asked: the detector is pure, and its text stays in the process.
    const { store, approvedFirms } = (deps.rules ?? DEFAULT_DEPS.rules!)();
    // A stop (an ECS SIGTERM) ends the run between items; the pass rows of what was read are still written.
    const stopping = new AbortController();
    deps.onStop?.(() => stopping.abort());
    const summary: DetectSummary = await runDetectOnce({
      tenantId: args.tenant,
      store,
      approvedFirms: () => approvedFirms(args.tenant),
      runId: crypto.randomUUID(),
      signal: stopping.signal,
    });
    deps.print(JSON.stringify(summary)); // integers and fixed codes only
    return;
  }
  if (args.estimate) {
    // Metadata only: no transport is built, so no model can be called and no recording is needed.
    deps.print(JSON.stringify(await estimateOnce({ tenantId: args.tenant, store: deps.store() })));
    return;
  }
  const transport = deps.transportFor(args); // a missing recording fails before any database client exists
  const store = deps.store();
  const stopping = new AbortController();
  deps.onStop?.(() => stopping.abort());
  // A pass that opens a budget prints the estimate it opened on, once, on its own line (numbers only).
  const once = () =>
    runExtractOnce({
      tenantId: args.tenant,
      transport,
      store,
      onEstimate: (e) => deps.print(JSON.stringify({ estimate: e })),
      signal: stopping.signal,
      sleep: deps.sleep,
    });
  const print = (summary: ExtractSummary) => {
    deps.print(JSON.stringify(summary));
    // A ZDR refusal turns AI off for the process, not just the batch: a failed item becomes eligible
    // again, so another pass would send it to the gateway again. The entrypoint exits 1 on this.
    if (summary.stoppedBy === 'zdr_unavailable') {
      throw new OperatorCopyError('extract stopped: the AI Gateway refused zero data retention, so AI is off; nothing more is sent');
    }
  };
  if (args.watch) {
    while (!stopping.signal.aborted) {
      print(await once()); // drains the recompute outbox each pass
      // A stop ends the wait at once; the rejection it raises is the stop itself, not an error.
      await sleep(WATCH_INTERVAL_MS, undefined, { signal: stopping.signal }).catch(() => undefined);
    }
    return;
  }
  const summary = await once();
  print(summary);
  if (args.strict && summary.failed > 0) process.exit(1); // CI: a recording miss fails the job
}

if (process.argv[1]?.endsWith('extract.ts') || process.argv[1]?.endsWith('extract.mjs')) {
  main().catch((err) => {
    // Setup copy written here (a flag, a variable, a replies path) as is; anything else a code, never a
    // database or model body (ADR-0017 decision 5).
    console.error(err instanceof OperatorCopyError ? err.message : `extract failed (${errorCodeOf(err)})`);
    process.exit(1);
  });
}
