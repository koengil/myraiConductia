// Demo-only (#460): the proposal step as the classify pass holds it. Delete this folder when #459 lands.
//
// classify-once --propose builds one step per tenant, before any mail is read:
// the gate (locks 2 to 4, gate.ts), then the transport and the store. syncSource
// hands it each page's unrouted messages in memory; the step runs proposeDeals
// on them and sums the counts. worker/classify.ts and worker/sync.ts are the only
// worker files that may import this folder's model side (eslint.config.mjs), and
// neither imports the model gateway itself: this file is where they meet.
//
// A team inbox is handed over only when its firm company is in `teamFirms` (G-01 #173): the firms named in
// TEAM_PROPOSAL_FIRMS that also hold a live team_proposals row. classify.ts works them out before this step is built,
// and the step intersects what it is given with the reviewed list again (review F8), so no caller can widen it.
// With none, the step reads a person's own mailbox only, exactly as it did before.

import { existsSync } from 'node:fs';

import type { SupabaseClient } from '@supabase/supabase-js';

import type { RoutedItem } from '@/lib/discovery/route/firmRules';
import type { FlagKey } from '@/lib/flags/keys';
import type { GateEnv, ProcessorPath } from '@/lib/modelGateway/processorGate';
import { loadRecording, recordedTransport } from '@/lib/modelGateway/record';
import { gatewayTransport, type ModelTransport, type TransportKind } from '@/lib/modelGateway/transports';

import { SubjectNames } from './alsoNamed';
import { listedTeamFirms, proposalGate, type TeamProposalFirm } from './gate';
import { SourcePasses, type PassOutcome } from './passes';
import { emptyStreak, emptyTally, proposeDeals, type ProposalStore, type ProposeTally } from './run';
import { supabaseProposalStore } from './store';

export type { ModelTransport } from '@/lib/modelGateway/transports';
export type { ProposalStore, ProposeTally } from './run';
export type { PassOutcome } from './passes';
export { MAX_CONSECUTIVE_FAILURES } from './run';

/** The global flag behind the step (lock 2), off by default. */
export const PROPOSE_FLAG: FlagKey = 'discovery_model_proposals_demo';
/** The owner's recording of the proposal prompt, when it is committed; the stub stands in until then. */
export const PROPOSE_REPLIES = 'tests/fixtures/discovery/demo/model-replies/propose.v2.json';
export const PROPOSE_STUB_REPLIES = 'tests/fixtures/discovery/demo/model-replies/propose.v2.stub.json';

/**
 * What one page of a run hands the step: the source it was read from, and the run. Whether the source is a team inbox
 * is SQL's answer at `begin`, from the source row, never the caller's (review F7).
 */
export type ProposeAt = { sourceId: string; runId: string };

export type ProposeStep = {
  /** The path the gate chose (recorded, synthetic or verified). */
  readonly path: ProcessorPath;
  /** Proposes for a page's unrouted messages; documents and routed entries are passed over (run.ts). */
  run(entries: readonly RoutedItem[], at: ProposeAt): Promise<void>;
  /** The counts so far, summed over every page and source: never a name, a subject or an id. */
  readonly tally: ProposeTally;
  /** True once MAX_CONSECUTIVE_FAILURES calls in a row failed: the run makes no more model calls. */
  readonly stopped: boolean;
  /** Set when the stop was the gateway refusing zero data retention (#462), or a usage row the ledger refused (#645), not a failure streak. */
  readonly stoppedBy?: 'zdr_unavailable' | 'ledger';
  /** The firm companies whose team inboxes the sync may hand over: both halves of the switch, or empty. */
  readonly teamFirms: ReadonlySet<string>;
  /** Sources the sync did not hand over (a team inbox of an unapproved firm, an ownerless mailbox) and sources a pass refusal stopped. Counts only. */
  readonly sources: { readonly skipped: number; readonly refused: number };
  /** The sync did not hand this source over (ADR-0026 exclusion 4); counted once per source. */
  noteSkipped(sourceId: string): void;
  /**
   * The sync is done with the source in this run: closes the team pass it holds, if any, with how it ended. A refusal
   * that stopped the source, or the step's own stop, names the outcome instead. Never throws.
   */
  endSource(at: { sourceId: string; runId: string }, outcome: PassOutcome): Promise<void>;
  /**
   * Closes the tenant's team passes whose lease lapsed (a run that died) as `unclosed`, once per run before any source
   * is read (review F5). A failure is swallowed: the next run sweeps again. Never throws.
   */
  closeLapsedPasses(): Promise<void>;
};

export type ProposeStepInput = {
  tenantId: string;
  db: SupabaseClient;
  /** The discovery_model_proposals_demo flag, read by the caller. */
  flagOn: boolean;
  /**
   * The firm company ids whose team inboxes may reach a model: TEAM_PROPOSAL_FIRMS for this tenant intersected with
   * the live team_proposals rows, worked out by runOnce (both halves, or nothing). Absent means none. The step keeps
   * only the ones the reviewed list names (review F8).
   */
  teamFirms?: readonly string[];
  /** Tests only: the reviewed team list. Production always runs on TEAM_PROPOSAL_FIRMS (gate.ts). */
  teamFirmList?: readonly TeamProposalFirm[];
  /** DISCOVERY_PROPOSE_TRANSPORT, AI_GATEWAY_API_KEY and the processor gate's variables. Defaults to process.env. */
  env?: GateEnv;
  /** Tests only: a transport to use instead of the one the environment names. */
  transport?: ModelTransport;
  /** Tests only: a store to use instead of the Supabase one. */
  store?: ProposalStore;
  /** Tests only: the wait between retries. */
  sleep?: (ms: number) => Promise<void>;
  /** Tests only: the clock the pass leases are judged on. */
  now?: () => number;
};

/**
 * What classify-once passes through: everything but the tenant, the client, the flag and the team firms, which it
 * supplies.
 */
export type ProposeOptions = Omit<ProposeStepInput, 'tenantId' | 'db' | 'flagOn' | 'teamFirms'>;

/** DISCOVERY_PROPOSE_TRANSPORT=gateway is a live call; anything else replays. */
export function proposeTransportKind(env: GateEnv): TransportKind {
  return env.DISCOVERY_PROPOSE_TRANSPORT === 'gateway' ? 'gateway' : 'recorded';
}

/** The owner's recording when it is committed, else the stub. */
export function proposeRepliesFile(exists: (path: string) => boolean = existsSync): string {
  return exists(PROPOSE_REPLIES) ? PROPOSE_REPLIES : PROPOSE_STUB_REPLIES;
}

function transportFor(kind: TransportKind, env: GateEnv): ModelTransport {
  if (kind === 'gateway') return gatewayTransport({ apiKey: env.AI_GATEWAY_API_KEY });
  return recordedTransport(loadRecording(proposeRepliesFile()));
}

/**
 * The step for one tenant, or the code of the lock that refused it. The gate runs first: a refusal builds no
 * transport, opens no recording and reads no mail.
 */
export function proposeStepFor(input: ProposeStepInput): { ok: true; step: ProposeStep } | { ok: false; code: string } {
  const env = input.env ?? process.env;
  const kind = input.transport?.kind ?? proposeTransportKind(env);
  const gate = proposalGate({ tenantId: input.tenantId, transportKind: kind, flagOn: input.flagOn, env });
  if (!gate.ok) return { ok: false, code: gate.code };

  const transport = input.transport ?? transportFor(kind, env);
  const store = input.store ?? supabaseProposalStore(input.db);
  const tally = emptyTally();
  // One streak for the whole run, across pages and sources; the firm's own domains are read once, on the first page.
  const streak = emptyStreak();
  // The firms the caller computed, kept only where the reviewed list names them: an approval row alone, or a caller
  // that passes a firm the list does not name, opens nothing (review F8).
  const listed = new Set(listedTeamFirms(input.tenantId, input.teamFirmList));
  const teamFirms: ReadonlySet<string> = new Set((input.teamFirms ?? []).filter((firm) => listed.has(firm)));
  // The passes of this run, by source. They send the firms to SQL, which checks both halves again.
  const passes = new SourcePasses({ tenantId: input.tenantId, store, firmIds: [...teamFirms], path: gate.path, now: input.now });
  const skipped = new Set<string>();
  let internal: Promise<ReadonlySet<string>> | null = null;
  // One subject-name tally per mailbox for the run, so one banker's mail never names another's deals (#623).
  const subjectNames = new Map<string, SubjectNames>();
  return {
    ok: true,
    step: {
      path: gate.path,
      tally,
      get stopped() {
        return streak.stopped;
      },
      get stoppedBy() {
        return streak.stoppedBy;
      },
      teamFirms,
      sources: {
        get skipped() {
          return skipped.size;
        },
        get refused() {
          return passes.refused;
        },
      },
      noteSkipped(sourceId) {
        skipped.add(sourceId);
      },
      async endSource(at, outcome) {
        // The source's own refusal wins (passes.ts); then a stop of the whole step; then how the read ended.
        const stop = streak.stopped ? (streak.stoppedBy ?? 'failure_streak') : outcome;
        await passes.end(at, stop);
      },
      async closeLapsedPasses() {
        await store.closeLapsedPasses(input.tenantId).catch(() => 0);
      },
      async run(entries, at) {
        internal ??= store.internalDomains(input.tenantId).then((domains) => new Set(domains));
        // proposeDeals checks the gate again before it reads any text.
        const page = await proposeDeals(entries, {
          tenantId: input.tenantId,
          runId: at.runId,
          sourceId: at.sourceId,
          sources: passes,
          gate: { flagOn: input.flagOn, env },
          transport,
          store,
          internalDomains: await internal,
          streak,
          sleep: input.sleep,
          subjectNames: subjectNames.get(at.sourceId) ?? subjectNames.set(at.sourceId, new SubjectNames()).get(at.sourceId),
        });
        for (const key of Object.keys(tally) as Array<keyof ProposeTally>) tally[key] += page[key];
        tally.costUsd = Math.round(tally.costUsd * 1_000_000) / 1_000_000;
      },
    },
  };
}
