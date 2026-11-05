// The extract loop (deal-zone worker). It owns no I/O: a model transport and a
// store are handed in, so tests run it in memory and phase 3 plugs in the
// Supabase store. The processor gate runs before any mail text is read.

import { costForUsage } from '@/lib/ai/pricing';
import type { AiCallUsage } from '@/lib/ai/usage';
import { callModel, type ModelCallResult } from '@/lib/modelGateway';
import { isRetryableZdrRefusal, ZDR_REFUSED_MESSAGE, ZDR_RETRY_DELAYS_MS, warnOnce } from '@/lib/modelGateway/gatewayClient';
import {
  assertProcessorAllowed,
  isSyntheticItem,
  type GateEnv,
  type ProcessorPolicy,
  resolveExtractModel,
  type ProcessorPath,
} from '@/lib/modelGateway/processorGate';
import { PROMPT_HASH, PROMPT_VERSION } from '@/lib/modelGateway/prompts/milestoneExtract.v1';
import type { ModelTransport, TransportKind } from '@/lib/modelGateway/transports';
import { MVP_DEAL_RAIL, type RailPhase } from '@/lib/rail/dealRail';

import type { MilestoneEvent } from '../milestones';
import { assessStage, type StageAssessment, type StationOverride } from '../stageEngine';
import { ceilingCostFor, estimateExtraction, type ExtractEstimate, type ExtractStats } from './estimate';
import { parseMilestoneReply, type ParsedMilestone, type ParseError } from './parse';

export type ExtractItem = {
  id: string;
  internetMessageId: string;
  contentHash: string;
  subject: string;
  sentAt: string | null;
  bodyText: string;
  attempt: number;
};

export type ModelCallRow = {
  sourceItemId: string;
  contentHash: string;
  purpose: 'milestone_extract';
  model: string;
  promptVersion: 'v1';
  promptHash: string;
  responseId: string | null;
  transport: TransportKind;
  outcome: 'ok' | 'invalid' | 'failed';
  errorCode: string | null;
  attempt: number;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
};

export type AssessTrigger = 'extraction' | 'correction' | 'rerun' | 'purge';

/** The open budget's state: ids, numbers and the model and prompt version it was opened for. */
export type BudgetState = {
  budgetId: string;
  itemCount: number;
  stopAtUsd: number;
  spentUsd: number;
  unpriced: number;
  model: string;
  promptVersion: string;
};
/**
 * Why a gateway pass stopped sending: a cost the ledger cannot see (including a reserved call that never
 * settled), the stop line, or an open budget that was estimated for another model or prompt version; or, from
 * the reservation (discovery_extract_reserve), a call in flight on the cohort (busy: another process, or one
 * never settled), a budget closed mid-pass, or an item outside the cohort; or a pending set that changed
 * between the estimate and the opening, so no budget opened (no_budget).
 */
export type CappedReason =
  | 'unpriced'
  | 'over_estimate'
  | 'budget_model_mismatch'
  | 'busy'
  | 'closed'
  | 'not_in_cohort'
  | 'no_budget';
/** What a reservation answers: ok, or why the item must not be sent. The codes of discovery_extract_reserve. */
export type ReserveResult = 'ok' | Exclude<CappedReason, 'budget_model_mismatch' | 'no_budget'>;

/** What an assessment's cited evidence came from, for its audit row: ids and codes only. */
export type AssessmentBasis = 'model' | 'rules' | 'mixed';

/**
 * One team inbox's audience of a candidate (#173 G-07): the events the inputs name for that inbox (current events
 * of the candidate's items held in it), and whether its latest scoped assessment still names a step.
 */
export type TeamAudience = { teamMailboxId: string; events: MilestoneEvent[]; live: boolean };

/**
 * The writer refused a scoped assessment because its team inbox is no longer allowed in the tenant (22023: the
 * inbox was refused, removed or disconnected since the inputs were read). Nobody reads a refused inbox's rows, so
 * the run skips that one row and carries on; the shared row and every other inbox are still written.
 */
export class TeamInboxRefusedError extends Error {
  constructor() {
    super('record assessment failed: team_inbox_not_allowed');
    this.name = 'TeamInboxRefusedError';
  }
}

export interface ExtractStore {
  /** With a budget id, only that budget's cohort (M1). */
  batch(tenantId: string, promptVersion: string, model: string, limit: number, budgetId?: string | null): Promise<ExtractItem[]>;
  /** Content-free statistics of what batch() would select: numbers only. */
  extractStats(tenantId: string, promptVersion: string, model: string): Promise<ExtractStats>;
  /** Returns the model_calls id. */
  saveCall(tenantId: string, call: ModelCallRow, events: ParsedMilestone[]): Promise<string>;
  /** Gateway calls only (T13). Throws if the ledger write fails (B1). externalId is never empty. */
  recordUsage(tenantId: string, u: AiCallUsage & { externalId: string }): Promise<void>;
  /**
   * B1: a gateway call whose cost the ledger cannot price (no usage, no price, no response id) or whose
   * call row could not be saved: a null-cost row keyed `externalId`, the response id or a client-made
   * `local:<uuid>`, never empty. Throws on failure.
   */
  recordUnpricedUsage(tenantId: string, externalId: string, model: string): Promise<void>;
  /**
   * A reservation before every send (M-1), gateway with a budget only. One atomic check and write across
   * processes: the budget is open, the item is in its cohort, no call is in flight on it, nothing is unpriced
   * and spent plus this item's ceiling fits under the stop line; then the item's in-flight mark is set and
   * 'ok' returned. Any other code writes nothing and the item is NOT sent; a failed call throws. The mark stays
   * set until settleCall, so a crash, a SIGKILL or a failed write mid-call leaves it set, and budgetState
   * counts it at the item's ceiling as unpriced.
   */
  reserveCall(tenantId: string, budgetId: string, itemId: string): Promise<ReserveResult>;
  /** Clears the reservation. Called LAST, once the call is on record; throws if the write fails or matches no row. */
  settleCall(tenantId: string, budgetId: string, itemId: string): Promise<void>;
  /** The open budget's state (ids and numbers), or null when none is open. Throws on a read error. */
  budgetState(tenantId: string): Promise<BudgetState | null>;
  /** Opens a budget with its cohort; null when the pending set changed (item count or total bytes) since the estimate. */
  openBudget(tenantId: string, e: ExtractEstimate, promptVersion: string): Promise<string | null>;
  candidatesToAssess(
    tenantId: string,
    touchedItemIds: string[],
  ): Promise<
    Array<{
      candidateId: string;
      /** The shared audience's events (the inputs' rows with no team inbox). */
      events: MilestoneEvent[];
      /** Each team inbox with events among the inputs, or whose latest scoped assessment names a step. */
      teams: TeamAudience[];
      override?: StationOverride;
      trigger: AssessTrigger;
      /** The recompute requests this assessment answers: completed only once it is saved. */
      requestIds: string[];
    }>
  >;
  /** Clears answered recompute requests. A request that is never completed is read again by the next run. */
  completeRequests(tenantId: string, requestIds: string[]): Promise<void>;
  /**
   * Saves the shared assessment, or with a team inbox the one scoped to that inbox's audience. A scoped save the
   * writer refuses because the inbox is no longer allowed throws TeamInboxRefusedError; every other failure throws.
   */
  saveAssessment(
    tenantId: string,
    candidateId: string,
    a: StageAssessment,
    trigger: string,
    scope?: { teamMailboxId: string | null; basis?: AssessmentBasis },
  ): Promise<boolean>;
}

export type ExtractSummary = {
  path: ProcessorPath;
  /** Why a gateway pass stopped sending, or null. Codes only. */
  capped: CappedReason | null;
  /** True on the pass that opened the budget; the estimate itself is printed once, on its own line. */
  opened: boolean;
  /** The budget at the start of this pass, and what this pass added (numbers only); null off the gateway. */
  budget: { itemCount: number; spentUsd: number; stopAtUsd: number; passSpendUsd: number } | null;
  selected: number;
  sent: number;
  skippedNotSynthetic: number;
  ok: number;
  invalid: number;
  failed: number;
  /** Shared assessments written. */
  assessed: number;
  /** Assessments scoped to a team inbox's audience written (a tombstone included). */
  assessedTeam: number;
  /** Scoped assessments skipped because their team inbox is no longer allowed (TeamInboxRefusedError). */
  teamRefused: number;
  /** Set when the run stopped early: the gateway refused zero data retention, so AI is off. */
  stoppedBy?: 'zdr_unavailable';
};

type Parsed = { ok: true; events: ParsedMilestone[] } | { ok: false; error: ParseError } | null;

function toRow(
  item: ExtractItem,
  model: string,
  transport: TransportKind,
  call: ModelCallResult,
  outcome: ModelCallRow['outcome'],
  parsed: Parsed,
): ModelCallRow {
  return {
    sourceItemId: item.id,
    contentHash: item.contentHash,
    purpose: 'milestone_extract',
    model,
    promptVersion: PROMPT_VERSION,
    promptHash: PROMPT_HASH,
    responseId: call.ok ? call.responseId || null : null,
    transport,
    outcome,
    errorCode: !call.ok ? call.code : parsed && !parsed.ok ? parsed.error : null,
    attempt: item.attempt,
    inputTokens: call.ok && call.usage ? call.usage.inputTokens : null,
    outputTokens: call.ok && call.usage ? call.usage.outputTokens : null,
    latencyMs: call.latencyMs,
  };
}

export async function runExtractOnce(opts: {
  tenantId: string;
  transport: ModelTransport;
  store: ExtractStore;
  rail?: readonly RailPhase[];
  env?: GateEnv;
  /** Tests only (fenced by tests/model-policy-injection-fence.test.ts): opens the verified path without editing the constants. */
  policy?: ProcessorPolicy;
  limit?: number;
  /** The worker prints the estimate when a pass opens a budget. */
  onEstimate?: (e: ExtractEstimate) => void;
  /**
   * Aborted (SIGTERM): no further item is sent, and no ZDR refusal is asked again. Checked between items and
   * between a refusal and its retry, never mid-call: the default wait before a retry ends at the abort.
   */
  signal?: AbortSignal;
  /** Tests only: the wait before a ZDR refusal is asked again. */
  sleep?: (ms: number) => Promise<void>;
}): Promise<ExtractSummary> {
  const sleep = opts.sleep ?? ((ms: number) => abortableSleep(ms, opts.signal));
  const path = assertProcessorAllowed(opts.tenantId, opts.transport.kind, opts.env, opts.policy); // before any text is read
  const model = resolveExtractModel(opts.env, path);
  const gateway = opts.transport.kind === 'gateway';
  const s: ExtractSummary = {
    path,
    capped: null,
    opened: false,
    budget: null,
    selected: 0,
    sent: 0,
    skippedNotSynthetic: 0,
    ok: 0,
    invalid: 0,
    failed: 0,
    assessed: 0,
    assessedTeam: 0,
    teamRefused: 0,
  };
  let state: BudgetState | null = null;
  if (gateway) {
    // The estimate is the bound (design Q4). It lives in the database, so a restart reuses it.
    state = await opts.store.budgetState(opts.tenantId);
    if (!state) {
      const estimate = estimateExtraction(await opts.store.extractStats(opts.tenantId, PROMPT_VERSION, model), model);
      if (estimate.stats.items > 0) {
        if (await opts.store.openBudget(opts.tenantId, estimate, PROMPT_VERSION)) {
          opts.onEstimate?.(estimate); // a fresh estimate, numbers only
          s.opened = true;
          state = await opts.store.budgetState(opts.tenantId);
        } else {
          s.capped = 'no_budget'; // the pending set moved since the estimate: nothing is sent, the next pass estimates again
        }
      }
    }
    if (state) {
      s.budget = { itemCount: state.itemCount, spentUsd: state.spentUsd, stopAtUsd: state.stopAtUsd, passSpendUsd: 0 };
      if (state.model !== model || state.promptVersion !== PROMPT_VERSION) s.capped = 'budget_model_mismatch'; // not this pass's bound
      else if (state.unpriced > 0) s.capped = 'unpriced'; // fail closed: a cost the ledger cannot see
      else if (state.spentUsd >= state.stopAtUsd) s.capped = 'over_estimate';
    }
  }
  // Off a budget a gateway pass sends nothing; on one, it reads only the cohort (M1).
  const items =
    gateway && (!state || s.capped)
      ? []
      : await opts.store.batch(opts.tenantId, PROMPT_VERSION, model, opts.limit ?? 50, state?.budgetId ?? null);
  s.selected = items.length;
  let passSpend = 0;
  const touched: string[] = [];
  for (const item of items) {
    if (opts.signal?.aborted) break; // a stop between items: the call in hand, if any, is already on record
    if (path === 'synthetic' && !isSyntheticItem(item.internetMessageId)) {
      s.skippedNotSynthetic++; // never sent
      continue;
    }
    const ceiling = state ? ceilingCostFor(item, model) : 0;
    if (state && state.spentUsd + passSpend + ceiling > state.stopAtUsd) {
      s.capped = 'over_estimate'; // B2: the stop line is checked before every call, with this item's worst case
      break;
    }
    // M-1: the reservation is on record before the item leaves. The check above reads this pass's own view; the
    // reservation checks again atomically against every process's. Refused, or not written, nothing is sent.
    if (state) {
      const reserved = await opts.store.reserveCall(opts.tenantId, state.budgetId, item.id);
      if (reserved !== 'ok') {
        s.capped = reserved;
        break;
      }
      if (opts.signal?.aborted) {
        // The stop landed while the reservation was being written: release it unsent.
        await opts.store.settleCall(opts.tenantId, state.budgetId, item.id);
        break;
      }
    }
    s.sent++;
    const send = () =>
      callModel(
        {
          purpose: 'milestone_extract',
          promptVersion: PROMPT_VERSION,
          model,
          tenantId: opts.tenantId,
          sourceItemId: item.id,
          contentHash: item.contentHash,
          input: { subject: item.subject, sentAt: item.sentAt, body: item.bodyText },
        },
        opts.transport,
      );
    let call = await send();
    // No ZDR provider serving right now can pass: ask again before stopping the batch (#625, D106).
    // A plan without ZDR (403) is never retried (D90). The retries sit inside this item's one reservation and
    // one stop-line check: a refused attempt reaches no provider, and only the final attempt is recorded and
    // counted (at its real cost, or at the item's ceiling if it failed), the same as SQL's budget state.
    // A stop ends the retries: the refusal in hand is the final attempt, recorded, counted at the item's ceiling
    // and settled below exactly as one that outlasted them, so the task exits inside its stop window.
    for (const ms of ZDR_RETRY_DELAYS_MS) {
      if (!isRetryableZdrRefusal(call) || opts.signal?.aborted) break;
      await sleep(ms);
      if (opts.signal?.aborted) break;
      call = await send();
    }
    const parsed: Parsed = call.ok ? parseMilestoneReply(call.text, item.bodyText) : null;
    const outcome: ModelCallRow['outcome'] = !call.ok ? 'failed' : parsed!.ok ? 'ok' : 'invalid';
    s[outcome]++;
    const row = toRow(item, model, opts.transport.kind, call, outcome, parsed);
    const events = parsed?.ok ? parsed.events : [];
    if (!gateway) {
      await opts.store.saveCall(opts.tenantId, row, events);
      if (!call.ok && call.code === 'zdr_unavailable') {
        // A plan without ZDR, or a provider gap that outlasted the retries: not this item's failure, and every later
        // item would be refused the same way. Stop the batch; nothing goes to another path or a direct provider.
        // Logged here, after the retries, never before them.
        warnOnce('discovery_extract', ZDR_REFUSED_MESSAGE);
        s.stoppedBy = 'zdr_unavailable';
        break;
      }
      if (outcome === 'ok') touched.push(item.id);
      continue;
    }
    if (call.ok) {
      // Ledger first (B1): the spend is on record before the call row, so a crash between the two leaves
      // a ledger row without a call (counted as unpriced), never a billed call nobody saw.
      const cost =
        call.usage && call.responseId ? costForUsage(call.usage.model.replace(/^anthropic\//, ''), call.usage) : null;
      let ledgerError: unknown = null;
      try {
        if (cost !== null) {
          await opts.store.recordUsage(opts.tenantId, { ...call.usage!, externalId: call.responseId });
        } else {
          // No usage, no price or no response id: record that this cost is unseen. Never key on an empty id.
          await opts.store.recordUnpricedUsage(opts.tenantId, call.responseId || `local:${crypto.randomUUID()}`, model);
        }
      } catch (err) {
        ledgerError = err;
      }
      // Always attempt the call row, so a failed ledger write still leaves a call the next pass counts as unpriced.
      await opts.store.saveCall(opts.tenantId, row, events);
      if (ledgerError) throw ledgerError; // the pass stops; the worker exits and ECS restarts it
      if (outcome === 'ok') touched.push(item.id);
      if (cost !== null) passSpend += cost;
      else s.capped = 'unpriced';
      await opts.store.settleCall(opts.tenantId, state!.budgetId, item.id); // last: the call and its spend are on record
      if (cost === null) break;
    } else {
      // A failed or timed-out call may have been billed: it counts at its ceiling (SQL counts it the same way).
      // A call that never left the process (no_key) costs nothing.
      const mayBeBilled = call.code !== 'no_key';
      try {
        await opts.store.saveCall(opts.tenantId, row, events);
      } catch (err) {
        if (mayBeBilled) {
          // Best effort: leave an unpriced row so the next pass stops instead of re-sending the item.
          await opts.store.recordUnpricedUsage(opts.tenantId, `local:${crypto.randomUUID()}`, model).catch(() => undefined);
        }
        throw err;
      }
      if (mayBeBilled) passSpend += ceiling;
      await opts.store.settleCall(opts.tenantId, state!.budgetId, item.id);
      if (call.code === 'zdr_unavailable') {
        // A plan without ZDR (403), or a provider gap (400) that outlasted the retries above: not this item's
        // failure, and every later item would be refused the same way. Stop the batch; nothing goes to another
        // path or a direct provider. Logged after the retries, never before. Settled first, so the item is not
        // left in flight for a later pass to count as unpriced.
        warnOnce('discovery_extract', ZDR_REFUSED_MESSAGE);
        s.stoppedBy = 'zdr_unavailable';
        break;
      }
    }
  }
  if (s.budget) s.budget.passSpendUsd = Math.round(passSpend * 1e6) / 1e6;
  // A capped pass still answers correction requests below: they call no model.
  const counts = await assessCandidates({ tenantId: opts.tenantId, store: opts.store, rail: opts.rail, touched });
  s.assessed += counts.assessed;
  s.assessedTeam += counts.assessedTeam;
  s.teamRefused += counts.teamRefused;
  return s;
}

/** The stores the assessment loop needs: the extract worker's, and the rule detector's (#173 G-07 slice 3b). */
export type AssessStore = Pick<ExtractStore, 'candidatesToAssess' | 'completeRequests' | 'saveAssessment'>;

/** What one assessment pass wrote: shared rows, scoped rows, and scoped rows skipped for a refused inbox. */
export type AssessCounts = { assessed: number; assessedTeam: number; teamRefused: number };

/**
 * Assesses every candidate with a live link to a touched item, and every one the recompute outbox names, with the
 * pure stage engine: the shared row, then one row per team inbox that adds evidence the shared audience lacks. Shared
 * by the extract worker and the rule detector's --rules mode (#173 G-07 slice 3b), so both fan out the same way. It
 * calls no model and reads no text: the inputs are ids, types, dates and confidence.
 */
export async function assessCandidates(opts: {
  tenantId: string;
  store: AssessStore;
  rail?: readonly RailPhase[];
  touched: string[];
}): Promise<AssessCounts> {
  const { tenantId, store, touched } = opts;
  const rail = opts.rail ?? MVP_DEAL_RAIL;
  const n: AssessCounts = { assessed: 0, assessedTeam: 0, teamRefused: 0 };
  for (const c of await store.candidatesToAssess(tenantId, touched)) {
    // The shared row first: everyone who sees the candidate reads it, and any failure of it stops the run as before.
    const shared = assessStage(c.events, rail, c.override);
    const sharedBasis = basisOf(c.events, shared);
    if (await store.saveAssessment(tenantId, c.candidateId, shared, c.trigger, { teamMailboxId: null, basis: sharedBasis })) {
      n.assessed++;
    }
    // Then one row per team inbox, only while the inbox adds evidence the shared audience lacks (#173 G-07, design
    // R3): its audience is assessed over the shared events plus its own. Once it adds nothing, a tombstone (no step,
    // no evidence) ends a stream that still names a step, so its readers fall back to the shared row.
    const sharedIds = new Set(c.events.map((e) => e.id));
    for (const t of c.teams) {
      const teamOnly = t.events.filter((e) => !sharedIds.has(e.id));
      const events = teamOnly.length > 0 ? [...c.events, ...teamOnly] : null;
      if (!events && !t.live) continue;
      const a = events ? assessStage(events, rail, c.override) : assessStage([], rail);
      try {
        const scope = { teamMailboxId: t.teamMailboxId, basis: events ? basisOf(events, a) : undefined };
        if (await store.saveAssessment(tenantId, c.candidateId, a, c.trigger, scope)) n.assessedTeam++;
      } catch (err) {
        if (!(err instanceof TeamInboxRefusedError)) throw err;
        n.teamRefused++; // nobody reads a refused inbox's rows; the shared row and the other inboxes still count
      }
    }
    // Only after the saves: a crash before this line leaves the request for the next run (assessing twice is a no-op).
    if (c.requestIds.length > 0) await store.completeRequests(tenantId, c.requestIds);
  }
  return n;
}

/** The basis of the events an assessment cites: model, rules or mixed. None for an assessment that cites nothing. */
function basisOf(events: MilestoneEvent[], a: StageAssessment): AssessmentBasis | undefined {
  const cited = new Set(a.evidenceEventIds);
  const kinds = new Set(events.filter((e) => cited.has(e.id)).map((e) => e.basis));
  if (kinds.size === 0) return undefined;
  return kinds.size > 1 ? 'mixed' : [...kinds][0];
}

/** Waits `ms`, or less: an abort ends the wait at once (and a signal already aborted does not wait). */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}
