// Demo-only (#460): one page's proposal pass. Delete this folder when #459 lands.
//
// The classify pass hands this the messages the firm rules left unrouted, in
// memory. For each one the model answers one combined question (is it deal mail,
// which deal, which phase), and one content-free row is written per settled
// answer. No subject, body, address or display name is stored or logged: a row
// carries the message's hashed identity, its date, its participant domains and
// the answer. Like the extractor (extract/run.ts), it owns no I/O: a transport
// and a store are handed in, and the gate runs before any text is read.

import { costForUsage } from '@/lib/ai/pricing';
import { TEAM_PROPOSAL_PASS_OUTCOME } from '@/lib/constants/discovery';
import type { RoutedItem } from '@/lib/discovery/route/firmRules';
import { billedAttempt, callModel, type BilledAttempt, type ModelCallResult } from '@/lib/modelGateway';
import { isRetryableZdrRefusal, ZDR_REFUSED_MESSAGE, ZDR_RETRY_DELAYS_MS, warnOnce } from '@/lib/modelGateway/gatewayClient';
import { isSyntheticItem, type GateEnv } from '@/lib/modelGateway/processorGate';
import {
  MAX_CANDIDATES,
  PROMPT_HASH,
  PROMPT_VERSION,
  type DealProposalCandidate,
  type ProposalPhaseId,
} from '@/lib/modelGateway/prompts/dealProposal.v2';
import type { ModelTransport } from '@/lib/modelGateway/transports';

import { SubjectNames } from './alsoNamed';
import { proposalGate, ProposalRefusedError } from './gate';
import { dealSlug, messageKey, modelKey } from './key';
import { parseProposalReply, type ProposalReply } from './parse';
import { TeamNotApprovedError, type PassStore, type SourcePasses } from './passes';

/** A transport failure is retried within the run, up to this many attempts; it is never written. */
export const MAX_ATTEMPTS = 3;
/** The wait before each retry: about 2s, then 8s. */
export const RETRY_DELAYS_MS = [2_000, 8_000] as const;
/** This many failed calls in a row stop the run's model calls: the gateway is down or refusing, so stop paying for it. */
export const MAX_CONSECUTIVE_FAILURES = 20;
/** The table's bounds (cardinality(party_domains) <= 100, char_length(deal_name) <= 80): one oversize message never stops a run. */
export const MAX_PARTY_DOMAINS = 100;
export const MAX_DEAL_NAME = 80;

/** One settled answer, as the store writes it: no text column exists. */
export type ProposalRow = {
  contentSourceId: string;
  messageKey: string;
  itemHash: string;
  sentAt: string | null;
  partyDomains: string[];
  outcome: 'deal' | 'not_deal' | 'invalid';
  /** Set when outcome is 'deal' only. */
  dealKey: string | null;
  dealName: string | null;
  candidateId: string | null;
  phase: ProposalPhaseId | null;
  pDeal: number | null;
  pPhase: number | null;
  model: string;
  promptVersion: typeof PROMPT_VERSION;
  promptHash: string;
  responseId: string | null;
  runId: string;
};

/** A known deal the prompt may name, with the candidate id behind a `c:` ref. */
export type KnownDeal = DealProposalCandidate & { candidateId: string | null };

export interface ProposalStore extends PassStore {
  /** The message keys of `keys` already answered from this source for this prompt version and model. */
  settledKeys(tenantId: string, sourceId: string, keys: readonly string[], promptVersion: string, model: string): Promise<Set<string>>;
  /**
   * The deals the prompt may name for mail read from this source: the live candidates this source's own mail backs
   * (`c:<id>`), then the deals the model named in this source's own mail (`m:<slug>`). Never another source's.
   */
  candidates(tenantId: string, sourceId: string): Promise<KnownDeal[]>;
  saveProposal(tenantId: string, row: ProposalRow): Promise<void>;
  /** The firm's own domains, those of its configured mailboxes (as worker/sync.ts reads them). Never a party. */
  internalDomains(tenantId: string): Promise<string[]>;
  /** One row per billed gateway attempt (#645): live calls only, never a replay. */
  recordUsage(tenantId: string, a: BilledAttempt): Promise<void>;
}

export type ProposeContext = {
  tenantId: string;
  runId: string;
  /** The mailbox source the page was read from: the row's owner. */
  sourceId: string;
  /**
   * The run's passes (passes.ts). Required, so a caller cannot forget them. Every source asks them before its first
   * model call, and SQL says from the source row whether it is a person's mailbox (no pass) or a team inbox (an
   * audited pass): the caller has no say in that (G-01 #173, review F7).
   */
  sources: SourcePasses;
  /** Locks 2 to 4 (gate.ts). Checked here again, before any text is read. */
  gate: { flagOn: boolean; env?: GateEnv };
  transport: ModelTransport;
  store: ProposalStore;
  /** The firm's own domains, dropped from every row's parties. */
  internalDomains?: ReadonlySet<string>;
  /** Failed calls in a row, shared by every page of a run; stopped once it reaches MAX_CONSECUTIVE_FAILURES. */
  streak?: FailureStreak;
  /** The wait between retries; tests pass one that does not wait. */
  sleep?: (ms: number) => Promise<void>;
  /** This mailbox's subject names for the run (#623): each page's routed entries add to it. */
  subjectNames?: SubjectNames;
};

export type FailureStreak = {
  consecutive: number;
  stopped: boolean;
  /**
   * Set when the gateway refused zero data retention (#462): AI is off for the run, nothing more is sent.
   * Or 'ledger' (#645): a billed attempt's ai_usage row could not be written, so nothing more is paid for.
   */
  stoppedBy?: 'zdr_unavailable' | 'ledger';
};

export const emptyStreak = (): FailureStreak => ({ consecutive: 0, stopped: false });

/** A billed attempt the ledger refused (#645). Content-free: no body, no id, no database message. */
class ProposeLedgerError extends Error {
  constructor() {
    super('propose ledger write failed');
    this.name = 'ProposeLedgerError';
  }
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Counts only: never a name, a subject or an id. */
export type ProposeTally = {
  called: number;
  deal: number;
  newNames: number;
  notDeal: number;
  failed: number;
  invalid: number;
  skippedNotSynthetic: number;
  costUsd: number;
};

export const emptyTally = (): ProposeTally => ({
  called: 0,
  deal: 0,
  newNames: 0,
  notDeal: 0,
  failed: 0,
  invalid: 0,
  skippedNotSynthetic: 0,
  costUsd: 0,
});

/** Outside participant domains, lowercased, distinct, sorted and capped: never a local part, a display name or the firm's own. */
export function participantDomains(entry: RoutedItem, internal: ReadonlySet<string> = new Set()): string[] {
  const domains = entry.item.participants
    .map((p) => p.address.slice(p.address.lastIndexOf('@') + 1).trim().toLowerCase())
    .filter((d) => /^[a-z0-9.-]+$/.test(d) && d.includes('.') && !internal.has(d));
  return [...new Set(domains)].sort().slice(0, MAX_PARTY_DOMAINS);
}

/** What the model's deal answer resolves to: a listed deal, or a new model-named one. */
function resolveDeal(
  deal: NonNullable<ProposalReply['deal']>,
  known: readonly KnownDeal[],
): { key: string; name: string; candidateId: string | null; isNew: boolean } {
  if ('ref' in deal) {
    const hit = known.find((k) => k.ref === deal.ref)!; // parseProposalReply admits listed refs only
    return { key: hit.ref, name: hit.name, candidateId: hit.candidateId, isNew: false };
  }
  // A new name that folds to a listed deal's name is that deal, so "Project Falcon" proposed for mail the
  // rules missed joins the rules-found Falcon candidate.
  const slug = dealSlug(deal.new_name);
  const same = known.find((k) => dealSlug(k.name) === slug);
  if (same) return { key: same.ref, name: same.name, candidateId: same.candidateId, isNew: false };
  return { key: modelKey(deal.new_name), name: deal.new_name, candidateId: null, isNew: true };
}

/**
 * Sends, and retries a failure; `onAttempt` sees every attempt as it returns, the ones a retry replaces too (#645).
 * `mayRetry` is asked after each wait, before a retry is sent: false ends the retries with the last failed answer.
 */
async function callWithRetry(
  send: () => Promise<ModelCallResult>,
  sleep: (ms: number) => Promise<void>,
  onAttempt: (call: ModelCallResult) => Promise<void>,
  mayRetry: () => Promise<boolean>,
): Promise<ModelCallResult> {
  let call = await send();
  await onAttempt(call);
  for (let attempt = 1; !call.ok && attempt < MAX_ATTEMPTS; attempt++) {
    // A plan without ZDR is never retried (D90). No ZDR provider serving right now can pass (#625, D106):
    // it waits longer, and only a refusal that outlasts the retries stops the run.
    const zdr = call.code === 'zdr_unavailable';
    if (zdr && !isRetryableZdrRefusal(call)) break;
    await sleep((zdr ? ZDR_RETRY_DELAYS_MS : RETRY_DELAYS_MS)[attempt - 1]);
    if (!(await mayRetry())) break;
    call = await send();
    await onAttempt(call);
  }
  return call;
}

/**
 * Proposes a deal and phase for each unrouted message of one page. Documents, routed entries and
 * messages already answered are passed over. On the synthetic path only committed corpus mail is sent.
 * Throws ProposalRefusedError, before reading any text, when a lock is closed.
 */
export async function proposeDeals(entries: readonly RoutedItem[], ctx: ProposeContext): Promise<ProposeTally> {
  const gate = proposalGate({
    tenantId: ctx.tenantId,
    transportKind: ctx.transport.kind,
    flagOn: ctx.gate.flagOn,
    env: ctx.gate.env,
  });
  if (!gate.ok) throw new ProposalRefusedError(gate.code); // before any text is read
  const tally = emptyTally();
  const streak = ctx.streak ?? emptyStreak();
  if (streak.stopped) return tally;
  // A team source that was refused, revoked or found busy stays stopped for the rest of the run (passes.ts).
  if (ctx.sources.isStopped(ctx.sourceId)) return tally;
  const internal = new Set([...(ctx.internalDomains ?? [])].map((d) => d.toLowerCase()));
  const sleep = ctx.sleep ?? wait;
  // A row the table refuses is counted failed and not written: the next run asks again, and this one carries on.
  // The writer's own refusal of a team row (the switch is off for the inbox's firm, or no pass is open) is no such
  // failure: it stops the source, and nothing more is sent from it (G-01 #173).
  const save = async (row: ProposalRow): Promise<boolean> => {
    try {
      await ctx.store.saveProposal(ctx.tenantId, row);
      return true;
    } catch (error) {
      if (error instanceof TeamNotApprovedError) {
        ctx.sources.refuse(ctx.sourceId, TEAM_PROPOSAL_PASS_OUTCOME.REVOKED);
      } else {
        tally.failed++;
      }
      return false;
    }
  };
  // Every billed attempt goes on the ledger as it returns, before anything is saved, so a retry never drops
  // the bill of the attempt it replaces (#645). Priced from tokens by pricing.ts; a replay writes nothing (T13).
  const meter = async (attempt: ModelCallResult): Promise<void> => {
    const billed = billedAttempt(attempt, gate.model);
    if (!billed) return;
    try {
      await ctx.store.recordUsage(ctx.tenantId, billed);
    } catch {
      throw new ProposeLedgerError();
    }
    if (billed.usage) tally.costUsd += costForUsage(billed.model.replace(/^anthropic\//, ''), billed.usage) ?? 0;
  };

  // This page's routed mail names its deals' parties for the prompt, before any unrouted message is asked (#623).
  const names = ctx.subjectNames ?? new SubjectNames();
  names.add(entries);
  // Messages leave `kind` unset (normalize/index.ts); only a document carries one.
  const messages = entries.filter((e) => e.routes.length === 0 && e.item.kind !== 'document');
  if (messages.length === 0) return tally;
  // Every source asks SQL before anything is asked or read for this page, and only on a page that has unrouted mail
  // (review F7): a person's mailbox is answered `personal` once per run, a team inbox opens its audited pass or renews
  // it. Any answer but ok stops the source for the run, whatever the caller thinks the source is.
  const at = { sourceId: ctx.sourceId, runId: ctx.runId };
  if (!(await ctx.sources.beginOrRenew(at))) return tally;
  ctx.sources.track(ctx.sourceId, tally);
  const keyOf = new Map(messages.map((e) => [e, messageKey(e.item.internetMessageId)]));
  const settled = await ctx.store.settledKeys(ctx.tenantId, ctx.sourceId, [...new Set(keyOf.values())], PROMPT_VERSION, gate.model);
  const known: KnownDeal[] = (await ctx.store.candidates(ctx.tenantId, ctx.sourceId)).slice(0, MAX_CANDIDATES);
  const named = new Set<string>(); // new deal keys this page, counted once each

  for (const entry of messages) {
    if (ctx.sources.isStopped(ctx.sourceId)) break; // the writer refused a team row: nothing more from this source
    const key = keyOf.get(entry)!;
    if (settled.has(key)) continue;
    if (gate.path === 'synthetic' && !isSyntheticItem(entry.item.internetMessageId)) {
      tally.skippedNotSynthetic++; // never sent
      continue;
    }
    // The lease is judged in memory before each call, and renewed (re-checking the switch in SQL) when it is about to
    // lapse. A person's mailbox holds no lease and always passes.
    if (!(await ctx.sources.ensureLease(at))) break;
    settled.add(key); // one message sighted twice on a page is asked once
    const domains = participantDomains(entry, internal);
    const candidates = known.map(({ ref, name }) => {
      const alsoNamed = names.for(name);
      return alsoNamed.length > 0 ? { ref, name, alsoNamed } : { ref, name };
    });
    tally.called++;
    let call: ModelCallResult;
    try {
      call = await callWithRetry(() =>
        callModel(
          {
            purpose: 'deal_proposal',
            promptVersion: PROMPT_VERSION,
            model: gate.model,
            tenantId: ctx.tenantId,
            contentHash: entry.item.contentHash,
            input: {
              subject: entry.item.subject,
              sentAt: entry.item.sentAt,
              body: entry.item.bodyText, // the prompt cuts it
              domains,
              candidates,
            },
          },
          ctx.transport,
        ),
        sleep,
        meter,
        // A retry chain can outlast the lease margin (the ZDR waits alone are a minute): the lease is judged again
        // before each retry is sent (review F9).
        () => ctx.sources.ensureLease(at),
      );
    } catch (err) {
      if (!(err instanceof ProposeLedgerError)) throw err;
      // A bill the ledger could not take: the answer is not saved, so an operator's rerun asks again, and the
      // step stops like a ZDR refusal, returning its tally. The sync and the tenant pass carry on (#645).
      tally.failed++;
      streak.stopped = true;
      streak.stoppedBy = 'ledger';
      break;
    }
    if (!call.ok) {
      tally.failed++; // not written: the next run asks again
      // The lease could not be kept before a retry: the source is stopped, and its failure is no streak of the gateway.
      if (ctx.sources.isStopped(ctx.sourceId)) break;
      if (call.code === 'zdr_unavailable') {
        // Every later message would be refused the same way: stop the run, retry nowhere else (#462).
        // Logged here, after any retries (D106), never before them.
        warnOnce('discovery_propose', ZDR_REFUSED_MESSAGE);
        streak.stopped = true;
        streak.stoppedBy = 'zdr_unavailable';
        break;
      }
      streak.consecutive++;
      if (streak.consecutive >= MAX_CONSECUTIVE_FAILURES) {
        streak.stopped = true;
        break;
      }
      continue;
    }
    streak.consecutive = 0;

    const parsed = parseProposalReply(call.text, candidates);
    const base = {
      contentSourceId: ctx.sourceId,
      messageKey: key,
      itemHash: entry.item.contentHash,
      sentAt: entry.item.sentAt,
      partyDomains: domains,
      model: gate.model,
      promptVersion: PROMPT_VERSION,
      promptHash: PROMPT_HASH,
      responseId: call.responseId || null,
      runId: ctx.runId,
    };
    const none = { dealKey: null, dealName: null, candidateId: null, phase: null };
    if (!parsed.ok) {
      if (await save({ ...base, ...none, outcome: 'invalid', pDeal: null, pPhase: null })) tally.invalid++;
      continue;
    }
    const { reply } = parsed;
    if (!reply.deal_related || reply.deal === null || reply.phase === null) {
      if (await save({ ...base, ...none, outcome: 'not_deal', pDeal: reply.p_deal, pPhase: null })) tally.notDeal++;
      continue;
    }
    const deal = resolveDeal(reply.deal, known);
    const saved = await save({
      ...base,
      outcome: 'deal',
      dealKey: deal.key,
      dealName: deal.name.trim().slice(0, MAX_DEAL_NAME),
      candidateId: deal.candidateId,
      phase: reply.phase,
      pDeal: reply.p_deal,
      pPhase: reply.p_phase,
    });
    if (!saved) continue;
    tally.deal++;
    if (deal.isNew && !named.has(deal.key)) {
      named.add(deal.key);
      tally.newNames++;
      // Later messages on this page may name it by ref, as later pages will once it is stored.
      if (known.length < MAX_CANDIDATES) known.push({ ref: deal.key, name: deal.name, candidateId: null });
    }
  }
  tally.costUsd = Math.round(tally.costUsd * 1_000_000) / 1_000_000;
  return tally;
}

