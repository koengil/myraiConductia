// One run of the rule detector over a tenant (#173 G-07 slice 3b, design R10): the worker's --rules mode. It builds
// no model transport and asks no processor gate: the detector is pure (rules.v1.ts), the text it reads stays in this
// process, and the run answers with integers and fixed codes only, never a sentence, a span or an address.
//
// The approval is checked before any mail is read: with no firm of the tenant approved for milestone_rules, the run
// reads no batch and only drains the recompute outbox (ids and types), so a revoke's queued recomputes still drop the
// rule events from every assessment. The writer checks the approval again on every item.

import { assessCandidates, type AssessCounts, type AssessStore } from '../extract/run';
import type { RailPhase } from '@/lib/rail/dealRail';

import { RULES_VERSION, detectMilestones } from './rules.v1';
import { DetectionRefusedError, TeamPassRefusedError, type DetectStore } from './store';

export const DETECT_BATCH = 50;
/** Items one run settles at most; the next run carries on. */
export const DETECT_MAX_ITEMS = 1000;

export type DetectSummary = AssessCounts & {
  mode: 'rules';
  /**
   * ok; capability_not_approved: no firm is approved, or an approval was revoked mid-run (the run stops for every
   * firm); stopped: a stop (SIGTERM) ended the run between items.
   */
  code: 'ok' | 'capability_not_approved' | 'stopped';
  firms: number;
  selected: number;
  detected: number;
  events: number;
  teamPasses: number;
  teamPassesRefused: number;
};

export async function runDetectOnce(opts: {
  tenantId: string;
  store: DetectStore & AssessStore;
  /** The firm company ids with milestone_rules on (loadTenantApprovals): any read error is none, which is off. */
  approvedFirms: () => Promise<string[]>;
  /** Names this run in each team inbox's pass row. */
  runId: string;
  rail?: readonly RailPhase[];
  batch?: number;
  maxItems?: number;
  /** Aborted (SIGTERM from ECS): no further item is read. Checked between items, never mid-write. */
  signal?: AbortSignal;
}): Promise<DetectSummary> {
  const s: DetectSummary = {
    mode: 'rules',
    code: 'ok',
    firms: 0,
    selected: 0,
    detected: 0,
    events: 0,
    teamPasses: 0,
    teamPassesRefused: 0,
    assessed: 0,
    assessedTeam: 0,
    teamRefused: 0,
  };
  let firms: string[] = [];
  try {
    firms = await opts.approvedFirms();
  } catch {
    firms = [];
  }
  s.firms = firms.length;
  const touched: string[] = [];
  const perTeam = new Map<string, { items: number; events: number }>();

  if (firms.length === 0) {
    s.code = 'capability_not_approved';
  } else {
    const batch = opts.batch ?? DETECT_BATCH;
    const maxItems = opts.maxItems ?? DETECT_MAX_ITEMS;
    // Every item the detector examined gets its team inbox's pass row, on a stop or a failure too: mail that was
    // read is always on the trail (audit round on #753). The first failure is the one the run ends with.
    let failure: unknown = null;
    try {
      await readAndDetect(batch, maxItems);
    } catch (err) {
      failure = err;
    }
    try {
      await recordPasses();
    } catch (err) {
      failure ??= err;
    }
    if (failure) throw failure;
  }

  const counts = await assessCandidates({ tenantId: opts.tenantId, store: opts.store, rail: opts.rail, touched });
  s.assessed = counts.assessed;
  s.assessedTeam = counts.assessedTeam;
  s.teamRefused = counts.teamRefused;
  return s;

  async function readAndDetect(batch: number, maxItems: number): Promise<void> {
    // Settled items leave the batch, so each read moves on; a revoke ends the run at the next write.
    reading: while (s.selected < maxItems) {
      if (opts.signal?.aborted) {
        s.code = 'stopped';
        break;
      }
      const items = await opts.store.detectBatch(opts.tenantId, RULES_VERSION, Math.min(batch, maxItems - s.selected));
      if (items.length === 0) break;
      for (const item of items) {
        if (opts.signal?.aborted) {
          s.code = 'stopped';
          break reading;
        }
        s.selected++;
        const events = detectMilestones(item.bodyText, item.sentAt ?? '');
        // On the inbox's trail once examined: items are the messages the detector ran on, events what it found.
        for (const team of item.teamMailboxIds) {
          const c = perTeam.get(team) ?? { items: 0, events: 0 };
          c.items++;
          c.events += events.length;
          perTeam.set(team, c);
        }
        try {
          await opts.store.recordDetection(
            opts.tenantId,
            { sourceItemId: item.id, contentHash: item.contentHash, rulesVersion: RULES_VERSION },
            events,
          );
        } catch (err) {
          if (!(err instanceof DetectionRefusedError)) throw err;
          s.code = 'capability_not_approved';
          break reading;
        }
        s.detected++;
        s.events += events.length;
        touched.push(item.id);
      }
    }
  }

  /** One pass row per team inbox this run read, for its firm admin and CCO (the team-inbox audit trail). */
  async function recordPasses(): Promise<void> {
    for (const [team, c] of [...perTeam].sort(([a], [b]) => a.localeCompare(b))) {
      try {
        await opts.store.recordTeamPass(opts.tenantId, team, opts.runId, c);
        s.teamPasses++;
      } catch (err) {
        if (!(err instanceof TeamPassRefusedError)) throw err;
        s.teamPassesRefused++; // the inbox was refused or removed since the batch: nobody reads its trail now
      }
    }
  }
}
