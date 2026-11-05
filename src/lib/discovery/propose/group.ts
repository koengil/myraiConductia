// Demo-only (#460): proposal rows grouped into the deals the MD sees. Delete this folder when #459 lands.
//
// Pure and model-free: the /discovery section uses it, so it imports
// nothing from the model gateway. A deal's phase is its highest proposed phase,
// the stage engine's lead rule (highest step wins) without regression handling.

import { GENERATED_PHASES } from '@/lib/rail/railData.generated';

import { proposedStepFor } from './station';

export type ProposalPhase = `phase-${1 | 2 | 3 | 4 | 5}`;

/**
 * A discovery_model_proposals row as the reader selects it. The reader also selects id and content_source_id,
 * for the covered link only; they are not on this type, so a group never carries them out of the server.
 */
export type ModelProposalRow = {
  message_key: string;
  outcome: string;
  deal_key: string | null;
  deal_name: string | null;
  candidate_id: string | null;
  phase: string | null;
  sent_at: string | null;
  party_domains: string[] | null;
};

/** discovery_model_proposal_accepts.failure_code (20261023140100): why an accept ended without a candidate. */
export const ACCEPT_FAILURE_CODES = ['none_readable', 'source_unavailable', 'candidate_closed', 'error'] as const;
export type AcceptFailureCode = (typeof ACCEPT_FAILURE_CODES)[number];

/** The station the model proposes for an `m:` deal, and how many of its emails the model placed in that phase. */
export type ModelProposalProposed = { stepId: string; phase: ProposalPhase; placed: number; of: number };

/**
 * Where an accept stands, for the owner's `m:` group: `pending` while the source's job still has to read the emails
 * (`requested` is how many), `failed` with a fixed code once it ended without a candidate. Null: none asked.
 */
export type ModelProposalAccept = { state: 'pending'; requested: number } | { state: 'failed'; code: AcceptFailureCode };

export type ModelProposalGroup = {
  dealKey: string;
  name: string;
  candidateId: string | null;
  phase: { id: ProposalPhase; name: string };
  /** Distinct messages, so two messages with the same text count twice and one message seen twice once. */
  emails: number;
  firstSentAt: string | null;
  lastSentAt: string | null;
  /** Participant domains. */
  parties: string[];
  /** A `c:` group whose candidate is already a mandate (it has a promoted deal). Always false for `m:`. */
  promoted: boolean;
  /**
   * Whether the viewer may act on it (Promote, Dismiss): every row it shows is on a personal mailbox the viewer owns.
   * False for a group with team-inbox rows until TH1-3 decides team triage, and false unless the reader checked.
   */
  actionable: boolean;
  /** Set for an actionable `m:` group only (owned personal sources); null for `c:` groups and for team rows. */
  proposed: ModelProposalProposed | null;
  /** Set for an actionable `m:` group with an accept in flight or failed; null otherwise. */
  accept: ModelProposalAccept | null;
  /**
   * Where a `c:` group's proposed deal came from: `model_proposal` for a deal accepted from a model proposal, `rules`
   * for one the codename rules found. Null for an `m:` group, which is no deal yet, and for a `c:` group whose origin
   * the database would not answer for (the row then words nothing about it). Never the cluster key.
   */
  origin: 'model_proposal' | 'rules' | null;
};

const PHASE_NAME = new Map(GENERATED_PHASES.map((p) => [`phase-${p.num}`, p.name]));
const phaseNum = (id: string) => Number(id.slice('phase-'.length));
const time = (at: string | null) => (at === null ? Number.NEGATIVE_INFINITY : Date.parse(at));

/** The row that leads: the higher phase, then the later sent_at. */
function leads(a: ModelProposalRow, b: ModelProposalRow): boolean {
  const byPhase = phaseNum(a.phase!) - phaseNum(b.phase!);
  return byPhase !== 0 ? byPhase > 0 : time(a.sent_at) >= time(b.sent_at);
}

/**
 * One entry per deal key over the 'deal' rows; newest deal first, then by name. `promoted` holds the ids of the
 * candidates that are already a mandate, as the reader read them under RLS; `actionable` the deal keys whose rows
 * all sit on a personal mailbox the viewer owns, as the reader checked them. A key not in it stays closed.
 * `modelOrigin` holds the ids of the candidates an accepted model proposal made (or that survive a merge of one), as the
 * reader read them; `originUnknown` the ids the database gave no origin for, whose groups carry none.
 */
export function groupProposals(
  rows: readonly ModelProposalRow[],
  promoted: ReadonlySet<string> = new Set(),
  actionable: ReadonlySet<string> = new Set(),
  accepts: ReadonlyMap<string, ModelProposalAccept> = new Map(),
  modelOrigin: ReadonlySet<string> = new Set(),
  originUnknown: ReadonlySet<string> = new Set(),
): ModelProposalGroup[] {
  const byKey = new Map<string, ModelProposalRow[]>();
  for (const row of rows) {
    if (row.outcome !== 'deal' || !row.deal_key || !row.deal_name || !row.phase || !PHASE_NAME.has(row.phase)) continue;
    byKey.set(row.deal_key, [...(byKey.get(row.deal_key) ?? []), row]);
  }
  const groups = [...byKey].map(([dealKey, list]): ModelProposalGroup => {
    const lead = list.reduce((best, row) => (leads(row, best) ? row : best));
    const latest = list.reduce((best, row) => (time(row.sent_at) > time(best.sent_at) ? row : best));
    const mine = dealKey.startsWith('m:') && actionable.has(dealKey);
    const messages = new Set(list.map((r) => r.message_key));
    const sent = list.map((r) => r.sent_at).filter((at): at is string => at !== null).sort((a, b) => time(a) - time(b));
    const candidateId = list.find((r) => r.candidate_id)?.candidate_id ?? null;
    return {
      dealKey,
      name: latest.deal_name!,
      candidateId,
      phase: { id: lead.phase as ProposalPhase, name: PHASE_NAME.get(lead.phase!)! },
      emails: messages.size,
      firstSentAt: sent[0] ?? null,
      lastSentAt: sent.at(-1) ?? null,
      parties: [...new Set(list.flatMap((r) => r.party_domains ?? []))].sort(),
      promoted: candidateId !== null && promoted.has(candidateId),
      actionable: actionable.has(dealKey),
      // The phase is the highest, as the accept RPC takes it; `placed` counts the distinct messages put there.
      proposed: mine
        ? {
            stepId: proposedStepFor(lead.phase as ProposalPhase),
            phase: lead.phase as ProposalPhase,
            placed: new Set(list.filter((r) => r.phase === lead.phase).map((r) => r.message_key)).size,
            of: messages.size,
          }
        : null,
      accept: mine ? accepts.get(dealKey) ?? null : null,
      origin: !dealKey.startsWith('c:')
        ? null
        : candidateId !== null && modelOrigin.has(candidateId)
          ? 'model_proposal'
          : candidateId !== null && originUnknown.has(candidateId)
            ? null
            : 'rules',
    };
  });
  return groups.sort((a, b) => time(b.lastSentAt) - time(a.lastSentAt) || a.name.localeCompare(b.name));
}
