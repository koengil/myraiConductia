// The exclusion policy evaluator (#263): pure, no IO, no model. It compares
// metadata literally. An instruction inside a marker header value or an address
// is data and never a command (R12).
//
// Every rule is evaluated, in policy order, with no early return, so the
// ledger's one reason (the first match, else the first unknown) and the thread taint (every
// thread-scoped match, never an unknown) are separate outputs and neither depends on rule order.

import type { ExcludeReason, MessageMetadata, PolicyRule, Verdict } from './types';

export type RuleResult = 'match' | 'no_match' | 'unknown';
export type Evaluation = { matches: PolicyRule[]; unknowns: PolicyRule[] };

const lower = (value: string): string => value.trim().toLowerCase();

/** The domain of an addr-spec (the part after its last @), lowercased; null when it has none. */
function domainOf(address: string): string | null {
  const at = address.lastIndexOf('@');
  const domain = at >= 0 ? lower(address.slice(at + 1)) : '';
  return domain === '' ? null : domain;
}

/**
 * Every address a participant rule may match: all the address headers the message carries, pooled (#337).
 * Reply-To and Sender are sender-controlled; under a thread-scoped rule they can taint the conversation like any
 * other address. Accepted as fail-closed (#337 design A1; scoping them to message rules is thread O2).
 */
function participantAddresses(p: Exclude<MessageMetadata['participants'], 'unparseable'>): string[] {
  return [...p.from, ...p.to, ...p.cc, ...p.bcc, ...p.replyTo, ...p.sender];
}

function evaluateRule(rule: PolicyRule, meta: MessageMetadata): RuleResult {
  switch (rule.kind) {
    case 'header_marker': {
      const value = meta.markers[rule.header];
      if (value === null) return 'no_match';
      return lower(value).includes(lower(rule.contains)) ? 'match' : 'no_match';
    }
    case 'participant_domain': {
      if (meta.participants === 'unparseable') return 'unknown';
      const wanted = rule.domains.map(lower);
      for (const address of participantAddresses(meta.participants)) {
        const domain = domainOf(address);
        if (domain && wanted.some((d) => domain === d || domain.endsWith(`.${d}`))) return 'match';
      }
      return 'no_match';
    }
    case 'participant_address': {
      if (meta.participants === 'unparseable') return 'unknown';
      const wanted = new Set(rule.addresses.map(lower));
      return participantAddresses(meta.participants).some((address) => wanted.has(lower(address))) ? 'match' : 'no_match';
    }
    case 'label': {
      // A provider's system ids (INBOX, CATEGORY_PERSONAL) match as they are; a user label by its name.
      const wanted = new Set(rule.names.map(lower));
      if (meta.labels.ids.some((id) => wanted.has(lower(id)))) return 'match';
      if (meta.labels.names === 'unavailable') return 'unknown';
      return meta.labels.names.some((name) => wanted.has(lower(name))) ? 'match' : 'no_match';
    }
    case 'classification': {
      // Absent could mean "no label" or "not returned": unverified, so it fails closed (R4).
      if (meta.classification === 'unavailable') return 'unknown';
      const hit = meta.classification.some(
        (value) =>
          value.labelId === rule.labelId &&
          (rule.fieldId === undefined || value.fieldId === rule.fieldId) &&
          (rule.selectionId === undefined || value.selectionId === rule.selectionId),
      );
      return hit ? 'match' : 'no_match';
    }
  }
}

/** Every rule against one message's metadata, in policy order. */
export function evaluateMessage(policy: { rules: readonly PolicyRule[] }, meta: MessageMetadata): Evaluation {
  const matches: PolicyRule[] = [];
  const unknowns: PolicyRule[] = [];
  for (const rule of policy.rules) {
    const result = evaluateRule(rule, meta);
    if (result === 'match') matches.push(rule);
    else if (result === 'unknown') unknowns.push(rule);
  }
  return { matches, unknowns };
}

const exclude = (reason: ExcludeReason, rule: PolicyRule): Verdict => ({ result: 'exclude', reason, ruleId: rule.id });

/**
 * The ledger's one reason for a message: the first matching rule in policy
 * order, else the first rule that could not be evaluated (fail closed), else pass.
 */
export function reasonOf(evaluation: Evaluation): Verdict {
  if (evaluation.matches.length > 0) return exclude('policy_excluded', evaluation.matches[0]);
  if (evaluation.unknowns.length > 0) return exclude('policy_unevaluable', evaluation.unknowns[0]);
  return { result: 'pass' };
}

/**
 * The thread-scoped rules that matched on one message: the rules that taint its conversation. Every match counts,
 * whichever rule is listed first, so a message that matches a message-scoped rule and a thread-scoped one taints its
 * thread all the same. A rule that could not be evaluated excludes its own message (fail closed, reasonOf) but taints
 * nothing: a taint is permanent, and an unknown (an unverified classification field, a label the list did not name)
 * would otherwise taint every thread it met and outlive the fix (security review, batch 2).
 */
export function taintsOf(evaluation: Evaluation): PolicyRule[] {
  return evaluation.matches.filter((rule) => rule.scope === 'thread');
}

/**
 * What a conversation's taint makes of a message that no rule excluded by itself: excluded as inherited, under the
 * first tainting rule in policy order. A rule id the policy no longer holds still excludes (it fails closed, under
 * the first id in sorted order), though the worker only ever hands over the current version's thread-scoped rules.
 */
export function inheritedVerdict(policy: { rules: readonly PolicyRule[] }, taintRuleIds: ReadonlySet<string> | undefined): Verdict {
  if (!taintRuleIds || taintRuleIds.size === 0) return { result: 'pass' };
  const rule = policy.rules.find((candidate) => taintRuleIds.has(candidate.id));
  const ruleId = rule?.id ?? [...taintRuleIds].sort()[0];
  return { result: 'exclude', reason: 'policy_thread_excluded', ruleId };
}

export type ThreadEvaluation = {
  verdict: Verdict;
  /** The thread-scoped rules this message carries that the thread's persisted taint did not hold yet. */
  newTaints: PolicyRule[];
};

/**
 * One conversation, oldest message first: a verdict for each message and the taints each one adds. The taint set is
 * the persisted one plus every thread-scoped match (or unknown) of every message the thread holds, in any order, so a
 * reply is excluded whether it comes before or after the message that matched; only matches are new taints (taintsOf).
 * A message that matches a rule keeps its own match as the ledger's reason; the others inherit the first tainting
 * rule in policy order.
 */
export function evaluateThread(
  policy: { rules: readonly PolicyRule[] },
  messages: readonly MessageMetadata[],
  persistedTaintRuleIds: ReadonlySet<string>,
): ThreadEvaluation[] {
  const evaluations = messages.map((meta) => evaluateMessage(policy, meta));
  const taintSet = new Set(persistedTaintRuleIds);
  for (const evaluation of evaluations) for (const rule of taintsOf(evaluation)) taintSet.add(rule.id);
  // Within the conversation being read, an unevaluable thread-scoped rule still fails closed for its siblings: the
  // thread is judged whole every time it is read, so this needs no persisted taint, and none is written for it.
  for (const evaluation of evaluations) {
    for (const rule of evaluation.unknowns) if (rule.scope === 'thread') taintSet.add(rule.id);
  }
  const inherited = inheritedVerdict(policy, taintSet);
  return evaluations.map((evaluation) => {
    const own = reasonOf(evaluation);
    return {
      verdict: own.result === 'exclude' ? own : inherited,
      newTaints: taintsOf(evaluation).filter((rule) => !persistedTaintRuleIds.has(rule.id)),
    };
  });
}

/** The verdict for one message under a policy. */
export function verdictFor(policy: { rules: readonly PolicyRule[] }, meta: MessageMetadata): Verdict {
  return reasonOf(evaluateMessage(policy, meta));
}

/**
 * After the raw fetch (R10): the label rules only, on the labels the fetched message now carries. The body has
 * already crossed, so a hit is recorded as an exclusion after the fetch, never as one before it. A label rule
 * that cannot be evaluated counts too: discarding is the safe direction. `matched` says which it was, since only a
 * real match may taint the conversation (taintsOf).
 */
export function labelRuleHit(
  policy: { rules: readonly PolicyRule[] },
  labels: MessageMetadata['labels'],
): { ruleId: string; matched: boolean } | null {
  const rules = policy.rules.filter((rule) => rule.kind === 'label');
  if (rules.length === 0) return null;
  const { matches, unknowns } = evaluateMessage(
    { rules },
    {
      labels,
      classification: 'unavailable',
      participants: { from: [], to: [], cc: [], bcc: [], replyTo: [], sender: [] },
      markers: { sensitivity: null, msip_labels: null },
    },
  );
  if (matches[0]) return { ruleId: matches[0].id, matched: true };
  return unknowns[0] ? { ruleId: unknowns[0].id, matched: false } : null;
}
