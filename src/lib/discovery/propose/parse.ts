// Demo-only (#460): the strict reader of a deal proposal reply. Delete this folder when #459 lands.
//
// A reply either parses into the one shape below or is `invalid`, which settles
// the message (as an extract parse failure does). Nothing from the reply is
// logged; a deal name is mail-derived, with the same sensitivity as codename_guess.

import { extractJsonPayload } from '@/lib/modelGateway/json';
import {
  MAX_NEW_NAME_CHARS,
  PROPOSAL_PHASES,
  type DealProposalCandidate,
  type ProposalPhaseId,
} from '@/lib/modelGateway/prompts/dealProposal.v2';

export type ProposalReply = {
  deal_related: boolean;
  p_deal: number;
  deal: { ref: string } | { new_name: string } | null;
  phase: ProposalPhaseId | null;
  p_phase: number;
};

export type ProposalParse = { ok: true; reply: ProposalReply } | { ok: false; code: 'invalid' };

const INVALID = { ok: false, code: 'invalid' } as const;
const PHASE_IDS: ReadonlySet<string> = new Set(PROPOSAL_PHASES.map((p) => p.id));

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isProbability = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;

function readDeal(v: unknown, refs: ReadonlySet<string>): ProposalReply['deal'] | undefined {
  if (v === null) return null;
  if (!isObject(v)) return undefined;
  const keys = Object.keys(v);
  if (keys.length !== 1) return undefined;
  if (keys[0] === 'ref') {
    return typeof v.ref === 'string' && refs.has(v.ref) ? { ref: v.ref } : undefined;
  }
  if (keys[0] === 'new_name') {
    if (typeof v.new_name !== 'string') return undefined;
    const name = v.new_name.trim();
    return name.length > 0 && name.length <= MAX_NEW_NAME_CHARS ? { new_name: name } : undefined;
  }
  return undefined;
}

/**
 * Parses one reply against the candidates the prompt listed. Invalid when the reply is not one JSON
 * object, a field has the wrong type, a probability is outside 0..1, a ref names no listed candidate,
 * a new name is empty or longer than 80 characters, or deal_related is true without both a deal and a
 * phase. A "no" carries no deal and no phase: any it gives are dropped.
 */
export function parseProposalReply(text: string, candidates: readonly DealProposalCandidate[]): ProposalParse {
  let data: unknown;
  try {
    data = JSON.parse(extractJsonPayload(text));
  } catch {
    return INVALID;
  }
  if (!isObject(data)) return INVALID;
  const { deal_related, p_deal, p_phase } = data;
  if (typeof deal_related !== 'boolean' || !isProbability(p_deal) || !isProbability(p_phase)) return INVALID;

  const deal = readDeal(data.deal, new Set(candidates.map((c) => c.ref)));
  if (deal === undefined) return INVALID;
  const phase = data.phase === null ? null : typeof data.phase === 'string' && PHASE_IDS.has(data.phase) ? (data.phase as ProposalPhaseId) : undefined;
  if (phase === undefined) return INVALID;

  if (!deal_related) return { ok: true, reply: { deal_related, p_deal, deal: null, phase: null, p_phase } };
  if (deal === null || phase === null) return INVALID;
  return { ok: true, reply: { deal_related, p_deal, deal, phase, p_phase } };
}
