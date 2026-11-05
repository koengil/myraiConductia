// Demo-only (#460): the audited pass a team inbox's source holds. Delete this folder when #459 lands.
//
// G-01 (#173), slice 5 of 5. A team inbox's mail may reach a model only inside a PASS: one row of the team
// proposal pass table for one (source, run), opened by `begin` (which checks both halves of the
// team_proposals switch in SQL and writes the `started` audit row), kept alive by `renew` (once per page, and again
// when the in-memory lease is about to lapse) and closed by `end` (the `finished` audit row). This file is the
// worker's side of that: it owns no I/O (a PassStore is handed in), keeps one small state per source, and FAILS CLOSED.
// Any refusal, a busy pass, a network error or a malformed answer stops that source for the rest of the run: the step
// sends nothing more from it and the pass is closed with the reason.
//
// The step asks SQL about EVERY source before its first model call (review F7): what kind of source it is comes from
// the source row, never from the caller. `begin` answers {scope: 'personal'} for a person's own mailbox still on the
// allowlist (no pass, nothing audited, cached here for the rest of the run), opens a pass for a team inbox both halves
// of the switch admit, and refuses anything else. A source with no ok answer sends nothing. With TEAM_PROPOSAL_FIRMS
// empty no team pass can open, so a person's mailbox is asked exactly as before, after one `begin` per run.
//
// Nothing here logs, and nothing here carries mail text, a subject, an address or a deal name: ids, fixed codes and
// integer counts only.

import { TEAM_PROPOSAL_PASS_OUTCOME, type TeamProposalPassOutcome } from '@/lib/constants/discovery';
import type { ProcessorPath } from '@/lib/modelGateway/processorGate';

/** The outcomes the worker may close a pass with: every outcome but `unclosed`, which only a later begin writes. */
export type PassOutcome = Exclude<TeamProposalPassOutcome, typeof TEAM_PROPOSAL_PASS_OUTCOME.UNCLOSED>;

/** What a pass keeps: five integers, as the pass table's counts column holds them. Never a name or an id. */
export type PassCounts = { asked: number; deal: number; notDeal: number; invalid: number; failed: number };

export const emptyPassCounts = (): PassCounts => ({ asked: 0, deal: 0, notDeal: 0, invalid: 0, failed: 0 });

/** The fields of a page's tally a pass counts (run.ts ProposeTally satisfies it); read live, so a mid-page renew is current. */
export type CountedTally = { called: number; deal: number; notDeal: number; invalid: number; failed: number };

/**
 * Why `begin` or `renew` did not open or extend a pass. The SQL refusals raise 42501 with the code as the message
 * (team_not_approved, team_inbox_not_allowed, no_reader; pass_closed and pass_not_open fold into `error`), a pass of
 * another run with a fresh lease raises 55P03 (pass_in_progress), and anything else is `error`.
 */
export type BeginRefusal = 'team_not_approved' | 'team_inbox_not_allowed' | 'no_reader' | 'pass_in_progress' | 'error';

export type BeginResult =
  | { ok: true; scope: 'personal' }
  | { ok: true; scope: 'team'; leaseUntil: string }
  | { ok: false; code: BeginRefusal };

/** The writer refused a team row: the switch is off for the inbox's firm, or no pass is open (SQLSTATE 42501 team_not_approved). */
export class TeamNotApprovedError extends Error {
  constructor() {
    super('team proposals are not approved for this source');
    this.name = 'TeamNotApprovedError';
  }
}

/** The pass half of the proposal store (store.ts). The Supabase one maps every failure to a BeginResult; it never throws on begin or renew. */
export interface PassStore {
  beginSource(tenantId: string, sourceId: string, runId: string, path: ProcessorPath, firmIds: readonly string[]): Promise<BeginResult>;
  renewSource(
    tenantId: string,
    sourceId: string,
    runId: string,
    firmIds: readonly string[],
    counts: PassCounts,
  ): Promise<BeginResult>;
  endSource(tenantId: string, sourceId: string, runId: string, outcome: PassOutcome, counts: PassCounts): Promise<void>;
  /** Closes the tenant's open passes whose lease has lapsed as `unclosed` (review F5); answers how many. May throw. */
  closeLapsedPasses(tenantId: string): Promise<number>;
}

/** A lease is renewed this long before it lapses, so a slow call or a little clock skew never sends under a lapsed one. */
export const LEASE_MARGIN_MS = 120_000;

/** The outcome a refusal closes the pass with. A switch turned off after the pass opened is `revoked`. */
function refusalOutcome(code: BeginRefusal, renewing: boolean): PassOutcome {
  if (code === 'error') return TEAM_PROPOSAL_PASS_OUTCOME.ERROR;
  if (code === 'team_not_approved' && renewing) return TEAM_PROPOSAL_PASS_OUTCOME.REVOKED;
  return TEAM_PROPOSAL_PASS_OUTCOME.REFUSED;
}

type SourceState = {
  /** begin answered ok: later pages renew. */
  begun: boolean;
  scope: 'personal' | 'team' | null;
  /** Epoch ms; 0 when unknown, which reads as lapsed. */
  leaseUntil: number;
  /** A pass may be open for this (source, run), so `end` must be sent. False after a definite refusal. */
  holds: boolean;
  /** Why the source stopped, once it has: the first reason stays. */
  refusal: PassOutcome | null;
  ended: boolean;
  tallies: CountedTally[];
};

export type SourcePassesDeps = {
  tenantId: string;
  store: PassStore;
  /** The reviewed firm company ids whose switch is on in both halves (classify.ts teamFirms): sent to SQL, which checks them again. */
  firmIds: readonly string[];
  path: ProcessorPath;
  /** Tests only: the clock. */
  now?: () => number;
};

/**
 * The passes of one run, by source. One instance per step; every method is safe to call for a source that holds no
 * pass (a person's mailbox), where it does nothing.
 */
export class SourcePasses {
  private readonly states = new Map<string, SourceState>();
  private readonly now: () => number;

  constructor(private readonly deps: SourcePassesDeps) {
    this.now = deps.now ?? Date.now;
  }

  private stateOf(sourceId: string): SourceState {
    let state = this.states.get(sourceId);
    if (!state) {
      state = { begun: false, scope: null, leaseUntil: 0, holds: false, refusal: null, ended: false, tallies: [] };
      this.states.set(sourceId, state);
    }
    return state;
  }

  /** True once the source is stopped for the run (a refusal, a busy pass, an error or the writer's 42501). */
  isStopped(sourceId: string): boolean {
    return this.states.get(sourceId)?.refusal != null;
  }

  /** Why the source stopped, as the outcome its pass closes with, or null while it has not. */
  refusalOf(sourceId: string): PassOutcome | null {
    return this.states.get(sourceId)?.refusal ?? null;
  }

  /** How many sources a refusal stopped, each counted once. Counts only: never an id. */
  get refused(): number {
    let n = 0;
    for (const state of this.states.values()) if (state.refusal != null) n++;
    return n;
  }

  /** Stops the source for the run with the reason its pass closes with. The first reason stays. */
  refuse(sourceId: string, outcome: PassOutcome): void {
    const state = this.stateOf(sourceId);
    state.refusal ??= outcome;
  }

  /** Adds a page's live tally to the source's counts. Only a source that holds a pass keeps them. */
  track(sourceId: string, tally: CountedTally): void {
    const state = this.states.get(sourceId);
    if (state?.holds) state.tallies.push(tally);
  }

  /** The source's counts so far, over every page tracked. */
  counts(sourceId: string): PassCounts {
    const total = emptyPassCounts();
    for (const t of this.states.get(sourceId)?.tallies ?? []) {
      total.asked += t.called;
      total.deal += t.deal;
      total.notDeal += t.notDeal;
      total.invalid += t.invalid;
      total.failed += t.failed;
    }
    return total;
  }

  /**
   * Whether the source may send now, judged in memory: true for a source that holds no pass, and for a team pass
   * whose lease has more than LEASE_MARGIN_MS left. A source with no state at all is not fresh: begin comes first.
   */
  leaseFresh(sourceId: string): boolean {
    const state = this.states.get(sourceId);
    if (!state || state.refusal != null || !state.begun) return false;
    if (state.scope === 'personal') return true;
    return this.now() < state.leaseUntil - LEASE_MARGIN_MS;
  }

  /**
   * The first page with unrouted mail opens the pass, each later page renews it. True means the step may go on;
   * false means the source is stopped (and counted once). Fails closed on anything but an ok answer.
   */
  async beginOrRenew(at: { sourceId: string; runId: string }): Promise<boolean> {
    const state = this.stateOf(at.sourceId);
    if (state.refusal != null) return false;
    if (!state.begun) return this.begin(at, state);
    if (state.scope === 'personal') return true;
    return this.renew(at, state);
  }

  /** Before a model call: true while the lease is fresh, else renews it. False stops the source. */
  async ensureLease(at: { sourceId: string; runId: string }): Promise<boolean> {
    const state = this.stateOf(at.sourceId);
    if (state.refusal != null) return false;
    if (this.leaseFresh(at.sourceId)) return true;
    if (!state.begun) return this.begin(at, state);
    return this.renew(at, state);
  }

  private async begin(at: { sourceId: string; runId: string }, state: SourceState): Promise<boolean> {
    const result = await this.attempt(() =>
      this.deps.store.beginSource(this.deps.tenantId, at.sourceId, at.runId, this.deps.path, this.deps.firmIds),
    );
    if (!result.ok) {
      // An unknown failure may have opened the pass before it answered: `end` is sent and is a no-op if it did not.
      if (result.code === 'error') state.holds = true;
      state.refusal ??= refusalOutcome(result.code, false);
      return false;
    }
    state.begun = true;
    state.scope = result.scope;
    if (result.scope === 'team') {
      state.holds = true;
      state.leaseUntil = leaseOf(result.leaseUntil);
    }
    return true;
  }

  private async renew(at: { sourceId: string; runId: string }, state: SourceState): Promise<boolean> {
    const result = await this.attempt(() =>
      this.deps.store.renewSource(this.deps.tenantId, at.sourceId, at.runId, this.deps.firmIds, this.counts(at.sourceId)),
    );
    if (!result.ok) {
      state.refusal ??= refusalOutcome(result.code, true);
      return false;
    }
    if (result.scope === 'team') state.leaseUntil = leaseOf(result.leaseUntil);
    return true;
  }

  /** A store that throws is an `error` answer: the step never sees an exception from begin or renew. */
  private async attempt(call: () => Promise<BeginResult>): Promise<BeginResult> {
    try {
      const result = await call();
      return result && typeof result === 'object' && 'ok' in result ? result : { ok: false, code: 'error' };
    } catch {
      return { ok: false, code: 'error' };
    }
  }

  /**
   * Closes the pass this run holds on the source. The source's own refusal reason wins over `outcome`. Does nothing
   * for a source that holds no pass or whose pass is already closed; a failed close is swallowed, because the lease
   * lapses and the next run's sweep (or a later begin) records the pass as unclosed.
   */
  async end(at: { sourceId: string; runId: string }, outcome: PassOutcome): Promise<void> {
    const state = this.states.get(at.sourceId);
    if (!state || !state.holds || state.ended) return;
    state.ended = true;
    try {
      await this.deps.store.endSource(this.deps.tenantId, at.sourceId, at.runId, state.refusal ?? outcome, this.counts(at.sourceId));
    } catch {
      // The pass stays open until its lease lapses.
    }
  }
}

/** A lease time as epoch ms; a value that does not parse reads as already lapsed, so the next call renews. */
function leaseOf(leaseUntil: string): number {
  const at = Date.parse(leaseUntil);
  return Number.isFinite(at) ? at : 0;
}
