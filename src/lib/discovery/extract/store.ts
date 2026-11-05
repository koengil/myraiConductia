// The Supabase store behind the extract loop's ports (service role, worker
// only). It is the one caller of the extractor's definer functions, and
// it never throws a database message: errors are codes, never text (ADR-0017
// decision 5). Stored text leaves the database through discovery_extract_batch
// alone, and events reach an assessment through discovery_audience_assessment_inputs (or, on a schema
// before 20261023130100, discovery_assessment_inputs).

import type { SupabaseClient } from '@supabase/supabase-js';

import { recordAiUsage } from '@/lib/ai/usage';
import { DISCOVERY_STATE, LINK_STATE, ROUTE_TIER, STAGE_TRIGGER } from '@/lib/constants/discovery';
import { TABLE } from '@/lib/constants/tables';
import { isMissingFunction } from '../missingFunction';

import type { MilestoneEvent, MilestoneType } from '../milestones';
import { ceilingPrices, toExtractStats } from './estimate';
import type { ParsedMilestone } from './parse';
import {
  TeamInboxRefusedError,
  type AssessTrigger,
  type ExtractItem,
  type ExtractStore,
  type ModelCallRow,
  type ReserveResult,
  type TeamAudience,
} from './run';

type BatchRow = {
  item_id: string;
  internet_message_id: string;
  content_hash: string;
  subject: string | null;
  sent_at: string | null;
  body_text: string;
  attempt: number;
};

/** Every code discovery_extract_reserve returns (20261021190000); anything else is a shape error. */
const RESERVE_RESULTS: readonly ReserveResult[] = ['ok', 'closed', 'not_in_cohort', 'busy', 'unpriced', 'over_estimate'];

type BudgetStateRow = {
  budget_id: string;
  item_count: number | string;
  stop_at_usd: number | string;
  spent_usd: number | string;
  unpriced: number | string;
  model: string;
  prompt_version: string;
};

function toExtractItem(row: BatchRow): ExtractItem {
  return {
    id: row.item_id,
    internetMessageId: row.internet_message_id,
    contentHash: row.content_hash,
    subject: row.subject ?? '',
    sentAt: row.sent_at,
    bodyText: row.body_text,
    attempt: row.attempt,
  };
}

const snake = (call: ModelCallRow) => ({
  purpose: call.purpose,
  model: call.model,
  prompt_version: call.promptVersion,
  prompt_hash: call.promptHash,
  source_item_id: call.sourceItemId,
  content_hash: call.contentHash,
  response_id: call.responseId,
  transport: call.transport,
  outcome: call.outcome,
  error_code: call.errorCode,
  attempt: call.attempt,
  input_tokens: call.inputTokens,
  output_tokens: call.outputTokens,
  latency_ms: call.latencyMs,
});

const snakeEvent = (e: ParsedMilestone) => ({
  type: e.type,
  occurred_at: e.occurredAt,
  span_start: e.spanStart,
  span_end: e.spanEnd,
  confidence: e.confidence,
});

/**
 * An outbox row's reason names why a recompute was asked for: a correction, or a purge that deleted a stream's
 * latest assessment (20261023130300). Anything else is a re-run.
 */
const triggerFor = (reason: string): AssessTrigger =>
  reason === STAGE_TRIGGER.CORRECTION || reason === STAGE_TRIGGER.PURGE ? reason : STAGE_TRIGGER.RERUN;

const fail = (what: string, error: { code?: string } | null): never => {
  throw new Error(`${what} failed: ${error?.code ?? 'unknown'}`);
};

type LinkRow = { candidate_id: string };
type InputRow = {
  candidate_id: string;
  source_item_id: string;
  event_id: string;
  type: string;
  occurred_at: string;
  confidence: number | string;
  extractor_version: string;
  created_at: string;
  /** null: the shared audience; a team inbox id: that inbox's audience (20261023130100). Absent before that migration. */
  team_mailbox_id?: string | null;
  /** 'model' when the event came from a model call, 'rules' from the rule detector. Absent before 20261023130100. */
  basis?: string;
};
/** A scoped assessment row: its audience, its step, and the keys the writer orders "latest" by (as_of, then id). */
type ScopedRow = { candidate_id: string; team_mailbox_id: string; step_id: string | null; as_of: string; id: string };

/** The rule before 20261023130400, for the shared-only inputs: each item's events at its newest extractor version. */
function newestVersionOnly(rows: InputRow[]): InputRow[] {
  const newest = new Map<string, { version: string; at: string }>();
  for (const e of rows) {
    const seen = newest.get(e.source_item_id);
    if (!seen || e.created_at > seen.at) newest.set(e.source_item_id, { version: e.extractor_version, at: e.created_at });
  }
  return rows.filter((e) => newest.get(e.source_item_id)?.version === e.extractor_version);
}

/**
 * Rows asked for per read. PostgREST caps a response at max_rows (1000, and a hosted project may cap it lower), so
 * every read below moves on by the rows it got and stops only on an empty page (propose/read.ts, review on #512):
 * a recompute queue, an input set or a scoped history past one response is read whole, never cut off silently.
 */
export const READ_PAGE = 1000;
/** Ids per `in` filter, so a long queue never builds an overlong query string. */
const ID_CHUNK = 100;

const chunks = <T,>(list: readonly T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += ID_CHUNK) out.push(list.slice(i, i + ID_CHUNK));
  return out;
};

type Page = PromiseLike<{ data: unknown; error: { code?: string } | null }>;

/** Reads a table by id, keyset by keyset (`after` is the last id read), until a page comes back empty. */
async function readById<T extends { id: string }>(page: (after: string | null) => Page, what: string): Promise<T[]> {
  const rows: T[] = [];
  for (let after: string | null = null; ; ) {
    const { data, error } = await page(after);
    if (error) fail(what, error);
    const got = (data ?? []) as T[];
    if (got.length === 0) return rows;
    rows.push(...got);
    after = got[got.length - 1].id;
  }
}

/** Reads a set-returning definer in a fixed order, offset by the rows already read, until a page comes back empty. */
async function readByOffset<T>(page: (from: number, to: number) => Page): Promise<{ rows: T[]; error: { code?: string } | null }> {
  const rows: T[] = [];
  for (let from = 0; ; ) {
    const { data, error } = await page(from, from + READ_PAGE - 1);
    if (error) return { rows, error };
    const got = (data ?? []) as T[];
    if (got.length === 0) return { rows, error: null };
    rows.push(...got);
    from += got.length;
  }
}

export function supabaseExtractStore(db: SupabaseClient): ExtractStore {
  /** Firm or confirmed, unrejected links of the named items: only candidate ids come back, never content. */
  async function liveLinks(by: { items: string[] }): Promise<LinkRow[]> {
    const query = db
      .from(TABLE.EVIDENCE_LINKS)
      .select('candidate_id')
      .neq('state', LINK_STATE.REJECTED)
      .not('candidate_id', 'is', null)
      .or(`route_tier.eq.${ROUTE_TIER.FIRM},state.eq.${LINK_STATE.CONFIRMED}`)
      .in('source_item_id', by.items);
    const { data, error } = await query;
    if (error) fail('read evidence links', error);
    return (data ?? []) as LinkRow[];
  }

  /** Deletes recompute requests by the ids that were read, so one asked for meanwhile stays. */
  async function clearRequests(ids: string[]): Promise<void> {
    for (const part of chunks(ids)) {
      const { error } = await db.from(TABLE.DISCOVERY_RECOMPUTE_REQUESTS).delete().in('id', part);
      if (error) fail('clear recompute requests', error);
    }
  }

  return {
    async batch(tenantId, promptVersion, model, limit, budgetId = null) {
      const { data, error } = await db.rpc('discovery_extract_batch', {
        p_tenant_id: tenantId,
        p_prompt_version: promptVersion,
        p_model: model,
        p_limit: limit,
        p_budget_id: budgetId,
      });
      if (error) fail('extract batch', error);
      return ((data ?? []) as BatchRow[]).map(toExtractItem);
    },

    async extractStats(tenantId, promptVersion, model) {
      const { data, error } = await db.rpc('discovery_extract_stats', {
        p_tenant_id: tenantId,
        p_prompt_version: promptVersion,
        p_model: model,
      });
      if (error) fail('extract stats', error);
      return toExtractStats(data); // every leaf Number(); a missing or non-numeric leaf throws 'extract stats failed: shape'
    },

    async saveCall(tenantId, call, events) {
      const { data, error } = await db.rpc('discovery_record_extraction', {
        p_tenant_id: tenantId,
        p_call: snake(call),
        p_events: events.map(snakeEvent),
      });
      if (error) fail('record extraction', error);
      return data as string;
    },

    async recordUsage(tenantId, u) {
      if (!u.externalId) fail('record ai usage', { code: 'no_external_id' }); // never key on an empty id (B1)
      // The gateway names models "anthropic/claude-sonnet-5"; the pricing table keys "claude-sonnet-5".
      const { error } = await recordAiUsage(db, {
        tenantId,
        actorId: null,
        source: 'discovery_extract',
        task: 'milestone_extract',
        externalId: u.externalId,
        model: u.model.replace(/^anthropic\//, ''),
        usage: u,
      });
      if (error) fail('record ai usage', { code: 'ledger' }); // the pass stops; the next one sees the gap as unpriced
    },

    async recordUnpricedUsage(tenantId, externalId, model) {
      if (!externalId) fail('record ai usage', { code: 'no_external_id' });
      const { error } = await recordAiUsage(db, {
        tenantId,
        actorId: null,
        source: 'discovery_extract',
        task: 'milestone_extract',
        externalId,
        model: model.replace(/^anthropic\//, ''),
        usage: null, // a null cost_usd: the budget counts the row as unpriced and the run stops
      });
      if (error) fail('record ai usage', { code: 'ledger' });
    },

    async budgetState(tenantId) {
      const { data, error } = await db.rpc('discovery_extract_budget_state', { p_tenant_id: tenantId });
      if (error) fail('read extract budget', error); // a refusal: no pass runs on an unread bound
      const row = ((data ?? []) as BudgetStateRow[])[0];
      return row
        ? {
            budgetId: row.budget_id,
            itemCount: Number(row.item_count),
            stopAtUsd: Number(row.stop_at_usd),
            spentUsd: Number(row.spent_usd),
            unpriced: Number(row.unpriced),
            model: row.model,
            promptVersion: row.prompt_version,
          }
        : null;
    },

    async reserveCall(_tenantId, budgetId, itemId) {
      // The budget id came from this tenant's own budgetState. The stop line, the busy check and the write are
      // one call under the budget's row lock (discovery_extract_reserve), so two processes cannot both pass it.
      const { data, error } = await db.rpc('discovery_extract_reserve', { p_budget_id: budgetId, p_item_id: itemId });
      if (error) fail('reserve extract call', error);
      if (!RESERVE_RESULTS.includes(data as ReserveResult)) fail('reserve extract call', { code: 'shape' });
      return data as ReserveResult;
    },

    async settleCall(_tenantId, budgetId, itemId) {
      const { error } = await db.rpc('discovery_extract_settle', { p_budget_id: budgetId, p_item_id: itemId });
      if (error) fail('settle extract call', error); // P0002: the write matched no row
    },

    async openBudget(tenantId, e, promptVersion) {
      const prices = ceilingPrices(e.model);
      const { data, error } = await db.rpc('discovery_extract_budget_open', {
        p_tenant_id: tenantId,
        p_model: e.model,
        p_prompt_version: promptVersion,
        p_expected_items: e.stats.items,
        p_expected_bytes: e.stats.subjectBytes.total + e.stats.bodyBytes.total,
        p_est_cost_usd: e.costUsd,
        p_stop_at_usd: e.stopAtUsd,
        p_estimate: e,
        p_overhead_bytes: e.assumptions.overheadBytesPerItem,
        p_bytes_per_token: e.assumptions.ceilingBytesPerToken, // a cohort ceiling is a worst case (m-5), not the expected-cost ratio
        p_input_usd_per_token: prices.inputUsdPerToken,
        p_output_ceiling_usd: prices.outputCeilingUsd,
      });
      if (error) fail('open extract budget', error);
      return (data as string | null) ?? null;
    },

    async candidatesToAssess(tenantId, touchedItemIds) {
      // Candidates of the tenant that own a live link to a touched item, plus every outbox row. A request is
      // cleared only after its assessment is saved (completeRequests), never as it is read.
      const triggerOf = new Map<string, AssessTrigger>();
      if (touchedItemIds.length > 0) {
        for (const link of await liveLinks({ items: touchedItemIds })) {
          triggerOf.set(link.candidate_id, STAGE_TRIGGER.EXTRACTION);
        }
      }
      // The whole queue, page by page: a revoke or a purge can queue more requests than one response holds, and a
      // request left unread would leave its candidate's assessment standing (audit S15).
      const requests = await readById<{ id: string; candidate_id: string; reason: string }>((after) => {
        const q = db.from(TABLE.DISCOVERY_RECOMPUTE_REQUESTS).select('id, candidate_id, reason').eq('tenant_id', tenantId);
        return (after ? q.gt('id', after) : q).order('id').limit(READ_PAGE);
      }, 'read recompute requests');
      for (const r of requests) {
        if (!triggerOf.has(r.candidate_id)) triggerOf.set(r.candidate_id, triggerFor(r.reason));
      }
      if (triggerOf.size === 0) return [];

      // Live candidates only (a rejected one is not assessed), in this tenant. Links carry no tenant column.
      type CandidateRow = { id: string; discovery_state: string; station_override_step_id: string | null };
      const candidateRows: CandidateRow[] = [];
      for (const part of chunks([...triggerOf.keys()])) {
        const got = await db
          .from(TABLE.DEAL_CANDIDATES)
          .select('id, discovery_state, station_override_step_id')
          .eq('tenant_id', tenantId)
          .in('id', part);
        if (got.error) fail('read candidates', got.error);
        candidateRows.push(...((got.data ?? []) as CandidateRow[]));
      }
      const liveRows = candidateRows.filter((c) => c.discovery_state !== DISCOVERY_STATE.REJECTED);
      const live = liveRows.map((c) => c.id);
      // A rejected candidate is never assessed, so nothing would ever answer its requests: clear them now.
      const liveSet = new Set(live);
      await clearRequests(requests.filter((r) => !liveSet.has(r.candidate_id)).map((r) => r.id));
      if (live.length === 0) return [];
      // The MD's step, stored on the candidate by a correction, so a re-run assesses against it.
      const overrideOf = new Map(liveRows.map((c) => [c.id, c.station_override_step_id]));

      // Each candidate's current events, through the one definer that narrows them to items that still have an
      // allowed source (#262 R15): a withdrawn, seat-lost or archived mailbox's events never feed an assessment,
      // whose text its readers see. Which events are current is decided there too, by the one rule every reader
      // shares (discovery_current_event_ids, 20261023130400): the latest ok model call for the item's current
      // content decides, even when it found nothing. So no version filter is kept for it. Before 20261023130100
      // lands the audience-tagged definer is missing, and the shared-only one it sits beside answers instead: it
      // returns every version, so its rows keep the old rule, each item's newest extractor version.
      const args = { p_tenant_id: tenantId, p_candidate_ids: live };
      // Paged in a fixed order (one row per candidate, item, event and audience), so a large input set is read whole
      // (audit S8).
      const inputsOf = (fn: string) =>
        readByOffset<InputRow>((from, to) => {
          const q = db.rpc(fn, args).order('candidate_id').order('source_item_id').order('event_id');
          return (fn === 'discovery_assessment_inputs' ? q : q.order('team_mailbox_id', { nullsFirst: true })).range(from, to);
        });
      let { rows: data, error } = await inputsOf('discovery_audience_assessment_inputs');
      const legacy = isMissingFunction(error);
      if (legacy) ({ rows: data, error } = await inputsOf('discovery_assessment_inputs'));
      if (error) fail('read assessment inputs', error);
      // One list per (candidate, audience): a row with no team inbox (or without the column, the schema before
      // 20261023130100) is the shared audience's; a row with inbox T is T's audience's alone, and never feeds the
      // shared assessment, whose readers need not be T's.
      const rows = data;
      const eventsOf = new Map<string, MilestoneEvent[]>();
      const audienceKey = (candidateId: string, teamMailboxId: string | null) => `${candidateId}|${teamMailboxId ?? ''}`;
      const teamsOf = new Map<string, Set<string>>();
      for (const e of legacy ? newestVersionOnly(rows) : rows) {
        const team = e.team_mailbox_id ?? null;
        const key = audienceKey(e.candidate_id, team);
        const list = eventsOf.get(key) ?? [];
        list.push({
          id: e.event_id,
          sourceItemId: e.source_item_id,
          type: e.type as MilestoneType,
          occurredAt: e.occurred_at,
          confidence: Number(e.confidence),
          basis: e.basis === 'rules' ? 'rules' : 'model',
        });
        eventsOf.set(key, list);
        if (team) teamsOf.set(e.candidate_id, (teamsOf.get(e.candidate_id) ?? new Set<string>()).add(team));
      }

      // Each candidate's scoped streams whose latest row still names a step: once its inbox adds nothing, the run
      // ends such a stream with a tombstone. Ids, a step and timestamps only.
      // The whole history, page by page, so a long one never hides a stream's latest row (audit S8).
      const scoped: ScopedRow[] = [];
      for (const part of chunks(live)) {
        scoped.push(
          ...(await readById<ScopedRow>((after) => {
            const q = db
              .from(TABLE.STAGE_ASSESSMENTS)
              .select('candidate_id, team_mailbox_id, step_id, as_of, id')
              .eq('tenant_id', tenantId)
              .in('candidate_id', part)
              .not('team_mailbox_id', 'is', null);
            return (after ? q.gt('id', after) : q).order('id').limit(READ_PAGE);
          }, 'read scoped assessments')),
        );
      }
      const latestScoped = new Map<string, ScopedRow>();
      for (const r of scoped) {
        const key = audienceKey(r.candidate_id, r.team_mailbox_id);
        const seen = latestScoped.get(key);
        if (!seen || r.as_of > seen.as_of || (r.as_of === seen.as_of && r.id > seen.id)) latestScoped.set(key, r);
      }
      for (const r of latestScoped.values()) {
        if (r.step_id !== null) teamsOf.set(r.candidate_id, (teamsOf.get(r.candidate_id) ?? new Set<string>()).add(r.team_mailbox_id));
      }

      return live.map((candidateId) => ({
        candidateId,
        override: overrideOf.get(candidateId) ? { stepId: overrideOf.get(candidateId)! } : undefined,
        events: eventsOf.get(audienceKey(candidateId, null)) ?? [],
        teams: [...(teamsOf.get(candidateId) ?? [])].sort().map(
          (teamMailboxId): TeamAudience => ({
            teamMailboxId,
            events: eventsOf.get(audienceKey(candidateId, teamMailboxId)) ?? [],
            live: (latestScoped.get(audienceKey(candidateId, teamMailboxId))?.step_id ?? null) !== null,
          }),
        ),
        trigger: triggerOf.get(candidateId) ?? STAGE_TRIGGER.EXTRACTION,
        requestIds: requests.filter((r) => r.candidate_id === candidateId).map((r) => r.id),
      }));
    },

    async completeRequests(_tenantId, requestIds) {
      await clearRequests(requestIds);
    },

    async saveAssessment(tenantId, candidateId, a, trigger, scope) {
      // A shared row leaves p_team_mailbox_id to its default (null). The basis (model, rules or mixed, of the cited
      // events) goes into the audit row; an assessment that cites nothing has none.
      const teamMailboxId = scope?.teamMailboxId ?? null;
      const { data, error } = await db.rpc('discovery_record_assessment', {
        p_tenant_id: tenantId,
        p_candidate_id: candidateId,
        p_assessment: scope?.basis ? { ...a, basis: scope.basis } : a,
        p_trigger: trigger,
        ...(teamMailboxId ? { p_team_mailbox_id: teamMailboxId } : {}),
      });
      // 22023 on a scoped row: its inbox is no longer an allowed team inbox of the tenant (the candidate and the basis
      // checks it shares with the shared row passed a moment ago, for the same candidate). The run skips that row.
      if (error && teamMailboxId && error.code === '22023') throw new TeamInboxRefusedError();
      if (error) fail('record assessment', error);
      return data === true;
    },
  };
}
