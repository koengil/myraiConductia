import type { ProposalReply } from '@/lib/discovery/propose/parse';

// The offline answers of the demo-only deal proposal step (#460), one per demo
// corpus message the firm rules can leave unrouted (see proposableItems in
// proposeStubReplies.ts). It is a test double, never a model output. Deals are
// named with `new_name`: a `ref` names a candidate id that exists only at run
// time, so a recorded reply cannot carry one. Delete with the step when #459 lands.

const NOT_DEAL: ProposalReply = { deal_related: false, p_deal: 0.03, deal: null, phase: null, p_phase: 0 };

export const PROPOSE_REPLY_TABLE: Readonly<Record<string, ProposalReply>> = {
  // A buyer's bid follow-up the codename rule misses: the demo's "found by the model" deal mail.
  '<bidq-002@castellan.example>': { deal_related: true, p_deal: 0.9, deal: { new_name: 'Project Kestrel' }, phase: 'phase-3', p_phase: 0.7 },
  '<bidq-003@castellan.example>': { deal_related: true, p_deal: 0.88, deal: { new_name: 'Project Kestrel' }, phase: 'phase-3', p_phase: 0.7 },
  '<falcon-004@heliotrope.example>': { deal_related: true, p_deal: 0.72, deal: { new_name: 'Project Falcon' }, phase: 'phase-1', p_phase: 0.55 },
  '<falcon-006@bank.example>': { deal_related: true, p_deal: 0.93, deal: { new_name: 'Project Falcon' }, phase: 'phase-2', p_phase: 0.8 },
  // Office, social and market mail.
  '<offsite-001@bank.example>': NOT_DEAL,
  '<lunch-006@bank.example>': NOT_DEAL,
  '<expenses-003@bank.example>': NOT_DEAL,
  '<noise-001@bank.example>': NOT_DEAL,
  '<noise-002@bank.example>': NOT_DEAL,
  '<noise-003@newswire.example>': NOT_DEAL,
  '<noise-004@bank.example>': NOT_DEAL,
  '<noise-005@bank.example>': NOT_DEAL,
  '<noise-006@bank.example>': NOT_DEAL,
  '<dinner-005@heliotrope.example>': NOT_DEAL,
  '<digest-007@newswire.example>': NOT_DEAL,
  '<fwd-008@bank.example>': NOT_DEAL,
};
