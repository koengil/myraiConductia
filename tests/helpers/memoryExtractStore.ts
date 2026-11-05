import { costForUsage } from '@/lib/ai/pricing';
import type { AiCallUsage } from '@/lib/ai/usage';
import { ceilingCostFor, describeSizes } from '@/lib/discovery/extract/estimate';
import {
  TeamInboxRefusedError,
  type BudgetState,
  type ExtractItem,
  type ExtractStore,
  type ModelCallRow,
} from '@/lib/discovery/extract/run';
import type { ParsedMilestone } from '@/lib/discovery/extract/parse';
import type { MilestoneEvent } from '@/lib/discovery/milestones';
import type { StageAssessment } from '@/lib/discovery/stageEngine';

import { demoPipeline } from '../../scripts/discovery/lib/demoPipeline';
import { DEMO_LATE_DIR } from '../discovery/demoCorpus';

const MAX_ATTEMPTS = 3;

/** A saved call, with the id saveCall returned and the store's clock when it was saved. */
type CallRecord = ModelCallRow & { id: string; at: number };
/** One ai_usage row for the extractor: a null cost is a row the ledger could not price. */
type LedgerRow = { externalId: string; costUsd: number | null; at: number };
type Budget = {
  id: string;
  itemCount: number;
  stopAtUsd: number;
  /** The model and prompt version the budget was opened for. */
  model: string;
  promptVersion: string;
  openedAt: number;
  closed: boolean;
  /** item id -> ceiling cost, as discovery_extract_budget_items holds it. */
  cohort: Map<string, number>;
  /** item id -> the store's clock when its call was reserved: discovery_extract_budget_items.inflight_since. Absent: none in flight. */
  inflight: Map<string, number>;
};

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * An in-memory ExtractStore over demoPipeline() groups, with the settled-attempt
 * rule: `ok` and `invalid` settle an item; `failed` retries up to three times.
 * Item ids are internetMessageIds.
 *
 * The budget, its cohort, the ledger and the calls live on the store object, so a second
 * runExtractOnce over the same store is a restart of the process over the same database.
 * budgetState() mirrors discovery_extract_budget_state (20261021190000) term for term, and reserveCall()
 * mirrors discovery_extract_reserve check for check, in its order.
 */
export function memoryExtractStore(dir: string) {
  const { items, groups } = demoPipeline(dir);
  const routedIds = new Set(groups.flatMap((g) => g.links.map((l) => l.internetMessageId)));
  const byId = new Map(items.map((i) => [i.item.internetMessageId, i.item]));
  const calls: CallRecord[] = [];
  const ledger: LedgerRow[] = [];
  /** Response ids of ledger rows planted by seedSpend: stand-ins for a priced row that has its call row. */
  const seededIds = new Set<string>();
  let clock = 0;
  const tick = () => ++clock;
  let budget: Budget | null = null;
  /** Events per item and extractor version ('<promptVersion>:<model>'), written once, as milestone_events holds them. */
  const eventsByVersion = new Map<string, MilestoneEvent[]>();
  const versionKey = (itemId: string, version: string) => `${itemId}|${version}`;
  /**
   * discovery_current_event_ids (20261023130400) for a model-only store: the latest ok call for the item's current
   * content decides, even when it found nothing; with no such call there are none (no rule events here).
   */
  const currentEvents = (itemId: string): MilestoneEvent[] => {
    const hash = byId.get(itemId)?.contentHash;
    const latest = [...calls].reverse().find((c) => c.sourceItemId === itemId && c.outcome === 'ok' && c.contentHash === hash);
    return latest ? (eventsByVersion.get(versionKey(itemId, `${latest.promptVersion}:${latest.model}`)) ?? []) : [];
  };
  /** The shared stream: each candidate's latest shared assessment. */
  const assessments = new Map<string, StageAssessment>();
  /**
   * Team audiences (#173 G-07): item id -> the team inbox that holds it, and whether an allowed personal mailbox
   * holds it too (a mixed item feeds the shared audience and the inbox's; a team-only item feeds the inbox's alone).
   * Items not listed are personal mail, as before.
   */
  const teamItems = new Map<string, { teamMailboxId: string; alsoPersonal: boolean }>();
  /** Inboxes no longer allowed: the writer refuses their scoped rows (22023), and the inputs name none of their events. */
  const refusedInboxes = new Set<string>();
  /** The scoped streams, as discovery_record_assessment keeps them: every row saved, oldest first, per `${candidate}|${inbox}`. */
  const scoped = new Map<string, Array<StageAssessment & { trigger: string; basis?: string }>>();
  const usage: Array<AiCallUsage & { externalId: string }> = [];
  /** The recompute outbox: a correction asks for an assessment of a candidate (cluster key). */
  const outbox: Array<{ id: string; candidateId: string }> = [];
  const control = {
    failAssessmentOnce: false,
    saveAttempts: 0,
    /** The next priced ledger write throws, as a failed database write does. */
    failLedgerOnce: false,
    /** The next saveCall throws, before the call is stored. */
    failSaveCallOnce: false,
    /** The next reserveCall throws, before anything is written (a read-only database, a grant regression). */
    failReserveOnce: false,
    /** The next settleCall throws, leaving the reservation set. */
    failSettleOnce: false,
    /** Budgets opened. */
    opened: 0,
  };

  const attemptsOf = (id: string) => calls.filter((c) => c.sourceItemId === id);
  const settled = (id: string) =>
    attemptsOf(id).some((c) => c.outcome !== 'failed') || attemptsOf(id).length >= MAX_ATTEMPTS;

  /** discovery_extract_budget_state for an open budget. */
  const stateOf = (b: Budget): BudgetState => {
    const since = ledger.filter((r) => r.at > b.openedAt);
    const sentSince = calls.filter((c) => c.transport === 'gateway' && c.at > b.openedAt);
    // spent: priced ledger rows, plus each failed call that left the process (not no_key) at its item's ceiling.
    const failedCeilings = sentSince
      .filter((c) => c.outcome === 'failed' && c.errorCode !== 'no_key')
      .reduce((sum, c) => sum + (b.cohort.get(c.sourceItemId) ?? 0), 0);
    // inflight: every cohort row still reserved counts at its ceiling and as one unpriced (outcome unknown).
    const reserved = [...b.inflight.keys()].reduce((sum, id) => sum + (b.cohort.get(id) ?? 0), 0);
    const spent = since.reduce((sum, r) => sum + (r.costUsd ?? 0), 0) + failedCeilings + reserved;
    // unpriced: (1) null-cost rows; (2) ok or invalid calls with no ledger row on their response id (a null
    // response id matches none); (3) priced rows that match no call's response id.
    const callIds = new Set([...sentSince.flatMap((c) => (c.responseId ? [c.responseId] : [])), ...seededIds]);
    const unpriced =
      since.filter((r) => r.costUsd === null).length +
      sentSince.filter((c) => c.outcome !== 'failed' && !since.some((r) => r.externalId === c.responseId)).length +
      since.filter((r) => r.costUsd !== null && !callIds.has(r.externalId)).length +
      b.inflight.size;
    return {
      budgetId: b.id,
      itemCount: b.itemCount,
      stopAtUsd: b.stopAtUsd,
      spentUsd: round6(spent),
      unpriced,
      model: b.model,
      promptVersion: b.promptVersion,
    };
  };

  const store: ExtractStore = {
    async batch(_tenant, _promptVersion, _model, limit, budgetId = null): Promise<ExtractItem[]> {
      if (budget && !budget.closed && budget.id !== budgetId) return []; // an open budget answers only a call that names it
      const cohort = budgetId && budget?.id === budgetId ? budget.cohort : null;
      return [...routedIds]
        .filter((id) => !settled(id) && (!cohort || cohort.has(id)))
        .slice(0, limit)
        .map((id) => {
          const item = byId.get(id)!;
          return {
            id,
            internetMessageId: id,
            contentHash: item.contentHash,
            subject: item.subject,
            sentAt: item.sentAt,
            bodyText: item.bodyText,
            attempt: attemptsOf(id).length + 1,
          };
        });
    },
    async extractStats() {
      // The same routed and unsettled filter as batch(), without the limit; byte lengths only.
      const pending = [...routedIds].filter((id) => !settled(id));
      const keyOf = new Map(groups.flatMap((g) => g.links.map((l) => [l.internetMessageId, g.clusterKey] as const)));
      return {
        items: pending.length,
        // The memory items carry no conversation id, so a thread is the cluster the item is routed to.
        threads: new Set(pending.map((id) => keyOf.get(id) ?? id)).size,
        bodyBytes: describeSizes(pending.map((id) => Buffer.byteLength(byId.get(id)!.bodyText, 'utf8'))),
        subjectBytes: describeSizes(pending.map((id) => Buffer.byteLength(byId.get(id)!.subject ?? '', 'utf8'))),
      };
    },
    async saveCall(_tenant, call: ModelCallRow, events: ParsedMilestone[]) {
      if (control.failSaveCallOnce) {
        control.failSaveCallOnce = false;
        throw new Error('record extraction failed: simulated');
      }
      calls.push({ ...call, id: `call-${calls.length + 1}`, at: tick() });
      if (call.outcome === 'ok') {
        // discovery_record_extraction: the call's events under its version, on conflict (type, span) do nothing.
        const key = versionKey(call.sourceItemId, `${call.promptVersion}:${call.model}`);
        const stored = eventsByVersion.get(key) ?? [];
        for (const e of events) {
          const id = `${call.sourceItemId}:${e.type}:${e.spanStart}`;
          if (stored.some((s) => s.id === id)) continue;
          stored.push({
            id,
            sourceItemId: call.sourceItemId,
            type: e.type,
            occurredAt: e.occurredAt,
            confidence: e.confidence,
            basis: 'model',
          });
        }
        eventsByVersion.set(key, stored);
      }
      return `call-${calls.length}`;
    },
    async recordUsage(_tenant, u) {
      if (control.failLedgerOnce) {
        control.failLedgerOnce = false;
        throw new Error('record ai usage failed: ledger');
      }
      if (!u.externalId) throw new Error('record ai usage failed: no_external_id');
      usage.push(u);
      ledger.push({ externalId: u.externalId, costUsd: costForUsage(u.model.replace(/^anthropic\//, ''), u), at: tick() });
    },
    async recordUnpricedUsage(_tenant, externalId) {
      if (!externalId) throw new Error('record ai usage failed: no_external_id');
      ledger.push({ externalId, costUsd: null, at: tick() });
    },
    async budgetState(): Promise<BudgetState | null> {
      return budget && !budget.closed ? stateOf(budget) : null;
    },
    async reserveCall(_tenant, budgetId, itemId) {
      if (control.failReserveOnce) {
        control.failReserveOnce = false;
        throw new Error('reserve extract call failed: simulated');
      }
      // discovery_extract_reserve, in its order: closed, not_in_cohort, busy, unpriced, over_estimate, ok.
      const b = budget;
      if (!b || b.closed || b.id !== budgetId) return 'closed';
      const ceiling = b.cohort.get(itemId);
      if (ceiling === undefined) return 'not_in_cohort';
      const answered = calls.some(
        (c) => c.sourceItemId === itemId && c.transport === 'gateway' && c.outcome !== 'failed' && c.at > b.openedAt,
      );
      // The batch's give-up rule; its 30-second back-off after a failure is SQL-only, as in batch() here.
      const givenUp = attemptsOf(itemId).filter((c) => c.outcome === 'failed').length >= MAX_ATTEMPTS;
      if (b.inflight.size > 0 || answered || givenUp) return 'busy';
      const st = stateOf(b);
      if (st.unpriced > 0) return 'unpriced';
      if (st.spentUsd + ceiling > st.stopAtUsd) return 'over_estimate';
      b.inflight.set(itemId, tick());
      return 'ok';
    },
    async settleCall(_tenant, budgetId, itemId) {
      if (control.failSettleOnce) {
        control.failSettleOnce = false;
        throw new Error('settle extract call failed: simulated');
      }
      if (!budget || budget.id !== budgetId || !budget.cohort.has(itemId)) throw new Error('settle extract call failed: no_row');
      budget.inflight.delete(itemId);
    },
    async openBudget(_tenant, e, promptVersion): Promise<string | null> {
      if (budget && !budget.closed) {
        // discovery_extract_budget_open raises budget_model_mismatch (P0004) rather than return another pair's budget.
        if (budget.model !== e.model || budget.promptVersion !== promptVersion) throw new Error('open extract budget failed: P0004');
        return budget.id;
      }
      // One read of the pending set, compared by item count and by total bytes (subject plus body), as SQL does.
      const pending = [...routedIds].filter((id) => !settled(id));
      const bytes = pending.reduce(
        (sum, id) => sum + Buffer.byteLength(byId.get(id)!.subject ?? '', 'utf8') + Buffer.byteLength(byId.get(id)!.bodyText, 'utf8'),
        0,
      );
      if (pending.length !== e.stats.items || bytes !== e.stats.subjectBytes.total + e.stats.bodyBytes.total) return null; // mail moved between the estimate and the opening
      control.opened++;
      budget = {
        id: `budget-${control.opened}`,
        itemCount: pending.length,
        stopAtUsd: e.stopAtUsd,
        model: e.model,
        promptVersion,
        openedAt: tick(),
        closed: false,
        cohort: new Map(pending.map((id) => [id, ceilingCostFor({ subject: byId.get(id)!.subject ?? '', bodyText: byId.get(id)!.bodyText }, e.model)])),
        inflight: new Map(),
      };
      return budget.id;
    },
    async candidatesToAssess(_tenant, touched) {
      const touchedSet = new Set(touched);
      const asked = new Set(outbox.map((r) => r.candidateId));
      return groups
        .filter((g) => asked.has(g.clusterKey) || g.links.some((l) => touchedSet.has(l.internetMessageId)))
        .map((g) => {
          // discovery_assessment_inputs: a personal or mixed item's events are the shared audience's; an item held in
          // an allowed inbox T also gives T's audience its events.
          const ids = g.links.map((l) => l.internetMessageId);
          const shared = ids.filter((id) => teamItems.get(id)?.alsoPersonal ?? true).flatMap(currentEvents);
          const byTeam = new Map<string, MilestoneEvent[]>();
          for (const id of ids) {
            const t = teamItems.get(id);
            if (!t || refusedInboxes.has(t.teamMailboxId)) continue;
            byTeam.set(t.teamMailboxId, [...(byTeam.get(t.teamMailboxId) ?? []), ...currentEvents(id)]);
          }
          const teams = new Set([...byTeam].filter(([, events]) => events.length > 0).map(([team]) => team));
          for (const [key, rows] of scoped) {
            const [candidateId, team] = key.split('|');
            if (candidateId === g.clusterKey && rows.at(-1)?.stepId) teams.add(team);
          }
          return {
            candidateId: g.clusterKey,
            events: shared,
            teams: [...teams].sort().map((teamMailboxId) => ({
              teamMailboxId,
              events: byTeam.get(teamMailboxId) ?? [],
              live: !!scoped.get(`${g.clusterKey}|${teamMailboxId}`)?.at(-1)?.stepId,
            })),
            trigger: (asked.has(g.clusterKey) ? 'correction' : 'extraction') as 'correction' | 'extraction',
            requestIds: outbox.filter((r) => r.candidateId === g.clusterKey).map((r) => r.id),
          };
        });
    },
    async completeRequests(_tenant, requestIds) {
      const done = new Set(requestIds);
      for (let i = outbox.length - 1; i >= 0; i--) if (done.has(outbox[i].id)) outbox.splice(i, 1);
    },
    async saveAssessment(_tenant, candidateId, a, trigger, scope) {
      control.saveAttempts++;
      if (control.failAssessmentOnce) {
        control.failAssessmentOnce = false;
        throw new Error('record assessment failed: simulated');
      }
      const team = scope?.teamMailboxId ?? null;
      if (team) {
        if (refusedInboxes.has(team)) throw new TeamInboxRefusedError();
        // Insert on change, per (candidate, audience), as the writer compares (step, lifecycle, flags, evidence).
        const rows = scoped.get(`${candidateId}|${team}`) ?? [];
        const last = rows.at(-1);
        const same = (x: StageAssessment) =>
          JSON.stringify([x.stepId, x.lifecycle, x.flags, [...x.evidenceEventIds].sort()]);
        if (last && same(last) === same(a)) return false;
        scoped.set(`${candidateId}|${team}`, [...rows, { ...a, trigger, basis: scope?.basis }]);
        return true;
      }
      const before = assessments.get(candidateId);
      assessments.set(candidateId, a);
      return JSON.stringify(before) !== JSON.stringify(a);
    },
  };
  return {
    store,
    calls,
    assessments,
    /** Scoped streams by `${candidateId}|${teamMailboxId}`, oldest row first. */
    scoped,
    /** Marks an item as held in a team inbox: team-only unless alsoPersonal. */
    teamItem(itemId: string, teamMailboxId: string, alsoPersonal = false) {
      teamItems.set(itemId, { teamMailboxId, alsoPersonal });
    },
    /** The inbox is no longer allowed: the inputs drop it and the writer refuses its rows. */
    refuseInbox(teamMailboxId: string) {
      refusedInboxes.add(teamMailboxId);
    },
    usage,
    ledger,
    /** The latest budget, open or closed; null before the first opens. */
    get budget(): Budget | null {
      return budget;
    },
    groups,
    items,
    outbox,
    control,
    /** Spend that is already on the ledger with its call row (null: a row the ledger could not price). */
    seedSpend(costUsd: number | null) {
      const externalId = `seed-${ledger.length + 1}`;
      ledger.push({ externalId, costUsd, at: tick() });
      if (costUsd !== null) seededIds.add(externalId);
    },
    /** Ends the open budget, as an operator would; the next gateway pass opens a new one over the pending set. */
    closeBudget() {
      if (budget) budget.closed = true;
    },
    /** New mail after a budget opened: merges the late demo mail's routed items and groups into this store. */
    addLateMail() {
      const late = demoPipeline(DEMO_LATE_DIR);
      for (const entry of late.items) {
        if (byId.has(entry.item.internetMessageId)) continue;
        byId.set(entry.item.internetMessageId, entry.item);
        items.push(entry);
      }
      for (const g of late.groups) {
        for (const l of g.links) routedIds.add(l.internetMessageId);
        const have = groups.find((x) => x.clusterKey === g.clusterKey);
        if (!have) groups.push(g);
        else for (const l of g.links) if (!have.links.some((x) => x.internetMessageId === l.internetMessageId)) have.links.push(l);
      }
    },
    /** A correction on the candidate with this cluster key. */
    ask(candidateId: string) {
      outbox.push({ id: `request-${outbox.length + 1}-${candidateId}`, candidateId });
    },
  };
}
