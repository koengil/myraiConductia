import {
  SourcePasses,
  TeamNotApprovedError,
  type BeginResult,
  type PassCounts,
  type PassOutcome,
} from '@/lib/discovery/propose/passes';
import type { KnownDeal, ProposalRow, ProposalStore } from '@/lib/discovery/propose/run';
import type { BilledAttempt } from '@/lib/modelGateway';
import type { ProcessorPath } from '@/lib/modelGateway/processorGate';

// An in-memory ProposalStore for the demo-only proposal step (#460) with the
// writer RPC's rules: one row per (tenant, source, message key, prompt version,
// model); a repeat answer updates the row. Known deals follow
// discovery_proposal_known_deals: a seeded candidate only for the owners it is
// visible to, and model-named deals only from the SAME SOURCE (the barrier is per
// source since G-01 #173 slice 1, not per owner), minus a key whose every row on
// this source a dismissal on this source lists (G-02a #173: the link of
// 20261023120100, by row id; a dismissal lists the rows of its key on its source
// that exist when it is made, so a later row of the key is not covered). Each
// source is its own owner unless `owners` maps it. Delete with the step when #459
// lands.
//
// It also models the team pass (G-01 #173): `teamSources` names the sources that are team inboxes and their firm
// company, `approvedFirms` the firm companies with a live team_proposals row. begin, renew and end follow the SQL
// definers (both halves of the switch, one open pass per source, a lease), and the writer refuses a team row
// without an approval or an open pass, as discovery_record_model_proposal does (TeamNotApprovedError). A scripted
// result replaces the model's answer for the next begin or renew call, for the refusals the tests need.

export type StoredProposal = ProposalRow & { tenantId: string; writes: number; id: number };

type Dismissal = { tenantId: string; sourceId: string; dealKey: string; ids: Set<number> };

/** One pass as the table holds it. */
export type StoredPass = {
  tenantId: string;
  sourceId: string;
  runId: string;
  firmId: string;
  path: string;
  leaseUntil: number;
  open: boolean;
  /** 'unclosed' is written by a later begin for a lapsed pass, never by the worker. */
  outcome: PassOutcome | 'unclosed' | null;
  counts: PassCounts | null;
};

export function memoryProposalStore(
  seed: {
    /** `visibleTo` lists the owners who can see the candidate; absent, every owner can. */
    candidates?: Array<KnownDeal & { visibleTo?: string[] }>;
    /** Source id to owner id; a source not listed is its own owner. */
    owners?: Record<string, string>;
    internalDomains?: string[];
    refuseSave?: (row: ProposalRow) => boolean;
    /** The ledger refuses every usage row, as the real store throws on a recordAiUsage error (#645). */
    failLedger?: boolean;
    /** The ledger takes this many usage rows, then refuses every one after (#645). */
    ledgerTakes?: number;
    /** Source id to the firm company of its team inbox. A source not listed is a person's mailbox. */
    teamSources?: Record<string, string>;
    /** The firm companies holding a live team_proposals row. Mutable through the returned `approvals`. */
    approvedFirms?: string[];
    /** The answers the next begin calls give instead of the model's (first in, first out). */
    scriptedBegin?: BeginResult[];
    /** The answers the next renew calls give instead of the model's. */
    scriptedRenew?: BeginResult[];
    /** The clock the leases are written on. */
    now?: () => number;
    /** Passes already in the table when the run starts (a run that died left them open). */
    passes?: StoredPass[];
  } = {},
) {
  const ownerOf = (sourceId: string) => seed.owners?.[sourceId] ?? sourceId;
  const now = seed.now ?? Date.now;
  const rows = new Map<string, StoredProposal>();
  const dismissals: Dismissal[] = [];
  let nextId = 0;
  // The covered rule of 20261023120200: a dismissal on the row's source, of its key, lists the row.
  const covered = (row: StoredProposal) =>
    dismissals.some(
      (d) => d.tenantId === row.tenantId && d.sourceId === row.contentSourceId && d.dealKey === row.dealKey && d.ids.has(row.id),
    );
  const usage: BilledAttempt[] = [];
  const approvals = new Set(seed.approvedFirms ?? []);
  const passes: StoredPass[] = (seed.passes ?? []).map((p) => ({ ...p }));
  const scriptedBegin = [...(seed.scriptedBegin ?? [])];
  const scriptedRenew = [...(seed.scriptedRenew ?? [])];
  /** Every pass call in order, for tests that pin the sequence: `begin`, `renew`, `end`, and `save` for each row. */
  const log: string[] = [];
  const calls = { settledKeys: 0, candidates: 0, saveProposal: 0, beginSource: 0, renewSource: 0, endSource: 0, closeLapsedPasses: 0 };
  const keyOf = (tenantId: string, r: { contentSourceId: string; messageKey: string; promptVersion: string; model: string }) =>
    `${tenantId}|${r.contentSourceId}|${r.messageKey}|${r.promptVersion}|${r.model}`;
  const LEASE_MS = 30 * 60_000;
  const openPass = (sourceId: string) => passes.find((p) => p.sourceId === sourceId && p.open);

  /** The three checks begin and renew make: the reviewed list (firmIds), the approval row, then the pass itself. */
  const gateOf = (sourceId: string, firmIds: readonly string[]): BeginResult | { firm: string } => {
    const firm = seed.teamSources?.[sourceId];
    if (firm === undefined) return { ok: true, scope: 'personal' };
    if (!firmIds.includes(firm) || !approvals.has(firm)) return { ok: false, code: 'team_not_approved' };
    return { firm };
  };

  const store: ProposalStore = {
    async settledKeys(tenantId, sourceId, keys, promptVersion, model) {
      calls.settledKeys++;
      return new Set(
        keys.filter((messageKey) => rows.has(keyOf(tenantId, { contentSourceId: sourceId, messageKey, promptVersion, model }))),
      );
    },
    async candidates(tenantId, sourceId) {
      calls.candidates++;
      const owner = ownerOf(sourceId);
      const known: KnownDeal[] = (seed.candidates ?? [])
        .filter((c) => !c.visibleTo || c.visibleTo.includes(owner))
        .map(({ ref, name, candidateId }) => ({ ref, name, candidateId }));
      const seen = new Set(known.map((k) => k.ref));
      // Per source: the deals the model named in THIS source's own mail, never another mailbox's of the same owner,
      // offered while any row of the key there is not covered (G-02a). The first row's name.
      const named = new Map<string, { name: string; open: boolean }>();
      for (const row of rows.values()) {
        if (row.tenantId !== tenantId || row.contentSourceId !== sourceId || row.outcome !== 'deal' || !row.dealKey?.startsWith('m:')) continue;
        const was = named.get(row.dealKey);
        named.set(row.dealKey, { name: was?.name ?? row.dealName!, open: (was?.open ?? false) || !covered(row) });
      }
      for (const [ref, { name, open }] of named) {
        if (seen.has(ref) || !open) continue;
        seen.add(ref);
        known.push({ ref, name, candidateId: null });
      }
      return known;
    },
    async saveProposal(tenantId, row) {
      calls.saveProposal++;
      log.push('save');
      // The writer's team branch: the firm's approval row and an open pass of this run (42501 team_not_approved).
      const firm = seed.teamSources?.[row.contentSourceId];
      if (firm !== undefined) {
        const pass = openPass(row.contentSourceId);
        if (!approvals.has(firm) || !pass || pass.runId !== row.runId) throw new TeamNotApprovedError();
      }
      // The table's checks, as the RPC would refuse them; a seed can refuse others.
      if (row.partyDomains.length > 100 || (row.dealName !== null && row.dealName.length > 80) || seed.refuseSave?.(row)) {
        throw new Error('record model proposal failed: 23514');
      }
      const key = keyOf(tenantId, row);
      const before = rows.get(key);
      rows.set(key, { ...row, tenantId, writes: (before?.writes ?? 0) + 1, id: before?.id ?? ++nextId });
    },
    async internalDomains() {
      return [...(seed.internalDomains ?? [])];
    },
    async recordUsage(_tenantId, a) {
      if (seed.failLedger || (seed.ledgerTakes !== undefined && usage.length >= seed.ledgerTakes)) throw new Error('record ai usage failed: ledger');
      usage.push(a);
    },

    async beginSource(tenantId, sourceId, runId, path, firmIds) {
      calls.beginSource++;
      log.push('begin');
      const scripted = scriptedBegin.shift();
      if (scripted) {
        if (scripted.ok && scripted.scope === 'team') {
          passes.push({ tenantId, sourceId, runId, firmId: seed.teamSources?.[sourceId] ?? '', path, leaseUntil: Date.parse(scripted.leaseUntil), open: true, outcome: null, counts: null });
        }
        return scripted;
      }
      const gate = gateOf(sourceId, firmIds);
      if (!('firm' in gate)) return gate;
      const open = openPass(sourceId);
      if (open && open.runId === runId) return { ok: true, scope: 'team', leaseUntil: new Date(open.leaseUntil).toISOString() };
      if (open) {
        if (open.leaseUntil > now()) return { ok: false, code: 'pass_in_progress' };
        open.open = false;
        open.outcome = 'unclosed';
      }
      if (passes.some((p) => p.sourceId === sourceId && p.runId === runId)) return { ok: false, code: 'error' }; // pass_closed
      const pass: StoredPass = { tenantId, sourceId, runId, firmId: gate.firm, path, leaseUntil: now() + LEASE_MS, open: true, outcome: null, counts: null };
      passes.push(pass);
      return { ok: true, scope: 'team', leaseUntil: new Date(pass.leaseUntil).toISOString() };
    },
    async renewSource(_tenantId, sourceId, runId, firmIds, counts) {
      calls.renewSource++;
      log.push('renew');
      const scripted = scriptedRenew.shift();
      if (scripted) return scripted;
      const gate = gateOf(sourceId, firmIds);
      if (!('firm' in gate)) return gate;
      const pass = openPass(sourceId);
      if (!pass || pass.runId !== runId) return { ok: false, code: 'error' }; // pass_not_open
      pass.leaseUntil = now() + LEASE_MS;
      pass.counts = counts;
      return { ok: true, scope: 'team', leaseUntil: new Date(pass.leaseUntil).toISOString() };
    },
    async endSource(_tenantId, sourceId, runId, outcome, counts) {
      calls.endSource++;
      log.push(`end:${outcome}`);
      const pass = openPass(sourceId);
      if (!pass || pass.runId !== runId) return; // no open pass for this run: nothing happens
      pass.open = false;
      pass.outcome = outcome;
      pass.counts = counts;
    },
    async closeLapsedPasses(tenantId) {
      calls.closeLapsedPasses++;
      log.push('sweep');
      // As discovery_close_lapsed_proposal_passes: every open pass of the tenant whose lease lapsed, whatever the switch says.
      let closed = 0;
      for (const pass of passes) {
        if (pass.tenantId !== tenantId || !pass.open || pass.leaseUntil > now()) continue;
        pass.open = false;
        pass.outcome = 'unclosed';
        closed++;
      }
      return closed;
    },
  };
  /** The source owner dismisses a deal key on one source now, listing its rows there (one dismissal row per source). */
  const dismiss = (tenantId: string, sourceId: string, dealKey: string) => {
    const ids = new Set(
      [...rows.values()]
        .filter((r) => r.tenantId === tenantId && r.contentSourceId === sourceId && r.dealKey === dealKey)
        .map((r) => r.id),
    );
    dismissals.push({ tenantId, sourceId, dealKey, ids });
  };
  return { store, rows: () => [...rows.values()], usage, calls, approvals, passes: () => [...passes], log, dismiss };
}

/**
 * The passes of a run over `store`, as the step builds them. A person's mailbox asks them once per run and is answered
 * `personal` (no pass), so a test of the personal path passes the default.
 */
export function passesFor(
  tenantId: string,
  store: ProposalStore,
  over: { firmIds?: readonly string[]; path?: ProcessorPath; now?: () => number } = {},
): SourcePasses {
  return new SourcePasses({ tenantId, store, firmIds: over.firmIds ?? [], path: over.path ?? 'recorded', now: over.now });
}
