import { ruleLayerReasons } from './screen';

/**
 * False-positive measurement for the pre-send email screen (MVP 2 plan,
 * week 1). A case is one email with the outcome a compliance reviewer would
 * want; this module runs it through the screen and names the result, so the
 * rate of ordinary mail that interrupts the banker can be tracked while the
 * rules are tuned.
 *
 * "Flagged" means the banker is interrupted: at send time the outbox returns
 * the email with issues (the Risk Patcher) instead of sending it. The rule
 * layer below is the deterministic part of that decision; the AI layer is
 * measured separately by scripts/screening-eval.ts --llm, because it costs
 * money and needs a key.
 */

export type EvalCase = {
  id: string;
  expected: 'clear' | 'flag';
  kind: string;
  subject: string;
  body: string;
};

export type EvalOutcome = 'ok' | 'false-positive' | 'caught' | 'missed';

export type EvalResult = {
  id: string;
  kind: string;
  expected: EvalCase['expected'];
  flagged: boolean;
  outcome: EvalOutcome;
  /** What triggered the flag, readable in a report. Empty when not flagged. */
  reasons: string[];
};

export type EvalSummary = {
  clear: number;
  falsePositives: number;
  /** falsePositives / clear, 0 when there are no clear cases. */
  falsePositiveRate: number;
  flag: number;
  caught: number;
  missed: number;
};

export function outcomeFor(expected: EvalCase['expected'], flagged: boolean): EvalOutcome {
  if (expected === 'clear') return flagged ? 'false-positive' : 'ok';
  return flagged ? 'caught' : 'missed';
}

/**
 * The rule layer exactly as the send path applies it to [subject, body]:
 * each field on its own, plus the MNPI check across fields.
 */
export function evaluateRules(cases: readonly EvalCase[]): EvalResult[] {
  return cases.map((c) => {
    const reasons = ruleLayerReasons([c.subject, c.body]);
    const flagged = reasons.length > 0;
    return {
      id: c.id,
      kind: c.kind,
      expected: c.expected,
      flagged,
      outcome: outcomeFor(c.expected, flagged),
      reasons,
    };
  });
}

export function summarize(results: readonly EvalResult[]): EvalSummary {
  const count = (outcome: EvalOutcome) => results.filter((r) => r.outcome === outcome).length;
  const clear = results.filter((r) => r.expected === 'clear').length;
  const falsePositives = count('false-positive');
  return {
    clear,
    falsePositives,
    falsePositiveRate: clear === 0 ? 0 : falsePositives / clear,
    flag: results.length - clear,
    caught: count('caught'),
    missed: count('missed'),
  };
}
