import { JEV_MODEL, jevRiskRead, type JevRead } from '@/lib/ai/jev';
import { assertModelDecision, type ModelCallDecision } from '@/lib/ai/modelPolicy';
import { isProductionAppEnv } from '@/lib/appEnv';
import { isEnabled } from '@/lib/flags/isEnabled';
import type { FlagSource } from '@/lib/flags/source';

import { crossFieldMnpiHold, findScreenHits, MNPI_FLAG, PROMISSORY_FLAG, type ScreenHit } from './screen';

/**
 * Jev as a second opinion on a send-time rule flag (D82, proposed).
 *
 * Runs only on the outbox send path, only when the deterministic rules leave
 * a flag after the sender's sign-offs. A clean email never reaches it. It may
 * LOWER a rule verdict, which nothing else in the screen may do, so every
 * path that is not a clear answer below the threshold keeps the flag: off,
 * misconfigured, timeout, HTTP error, unreadable reply (fail closed).
 *
 * Off by default. The policy below is PROVISIONAL, pending Storm and Dan
 * (D82 option A/B/C and the threshold); turning it on also needs the model
 * gate (#339) to allow 'mail_send_second_opinion' for the tenant, and
 * TypeSafe AI's written zero-data-retention terms.
 */

/** Both of Jev's probabilities must be below this to clear a flag. */
export const SECOND_OPINION_DEFAULT_THRESHOLD = 0.05;
/** A configured threshold above this is a misconfiguration: the feature stays off. */
export const SECOND_OPINION_MAX_THRESHOLD = 0.2;

/**
 * Which rule flags Jev may clear. 'promissory_and_mnpi' is D82 option A (a
 * cleared send floors at Sampled); 'promissory_only' is option B (an MNPI
 * flag always stands).
 */
export const SECOND_OPINION_CLEARS = ['promissory_and_mnpi', 'promissory_only'] as const;
export type SecondOpinionClears = (typeof SECOND_OPINION_CLEARS)[number];

export type SecondOpinionPolicy = { threshold: number; clears: SecondOpinionClears };

/**
 * cleared: Jev put both risks below the threshold, the rule flag is lifted.
 * kept: Jev answered, at or above the threshold.
 * skipped: Jev was not asked (a flag the policy may not clear, or a rule hit
 *   outside the subject and body, which Jev never reads).
 * error: Jev did not answer usably (timeout, HTTP, unreadable).
 */
export type SecondOpinionOutcome = 'cleared' | 'kept' | 'skipped' | 'error';

/** What the screen audit row records. No probabilities, no content. */
export type SecondOpinionRecord = {
  outcome: SecondOpinionOutcome;
  threshold: number;
  /** The rule reasons a clear lifted; empty unless outcome is 'cleared'. */
  clearedReasons: string[];
};

export const SECOND_OPINION_ENV = {
  threshold: 'JEV_SECOND_OPINION_THRESHOLD',
  clears: 'JEV_SECOND_OPINION_CLEARS',
  apiKey: 'AI_GATEWAY_API_KEY',
} as const;

type Env = Record<string, string | undefined>;

/**
 * The policy from the environment. Unset values take the provisional
 * defaults; a value that is set but invalid turns the feature off (null),
 * never into a looser policy.
 */
export function readSecondOpinionPolicy(env: Env = process.env): SecondOpinionPolicy | null {
  const rawThreshold = env[SECOND_OPINION_ENV.threshold]?.trim();
  let threshold = SECOND_OPINION_DEFAULT_THRESHOLD;
  if (rawThreshold) {
    if (!/^\d*\.?\d+$/.test(rawThreshold)) return null;
    threshold = Number(rawThreshold);
    if (!(threshold > 0 && threshold <= SECOND_OPINION_MAX_THRESHOLD)) return null;
  }
  const rawClears = env[SECOND_OPINION_ENV.clears]?.trim();
  // Option B while the policy is provisional: a stray flag can never let Jev clear MNPI.
  let clears: SecondOpinionClears = 'promissory_only';
  if (rawClears) {
    if (!(SECOND_OPINION_CLEARS as readonly string[]).includes(rawClears)) return null;
    clears = rawClears as SecondOpinionClears;
  }
  return { threshold, clears };
}

/**
 * The one seam every Jev call on the send path goes through: the model gate
 * (#339) allowed 'mail_send_second_opinion' for the sender's tenant, AND the
 * `mail_jev_second_opinion` flag is on, AND the Jev env config is present and
 * valid. Returns the policy, or null when no call may happen. A decision not
 * minted by modelCallsAllowed for that purpose throws (secondOpinionOn turns
 * that into no call).
 */
export async function jevCallAllowed(
  model: ModelCallDecision,
  flags: FlagSource,
  env: Env = process.env,
): Promise<SecondOpinionPolicy | null> {
  // The per-tenant gate first: a withheld tenant never reads the flag. With
  // the verified list empty, only the DEV tenant on a local dev stack passes.
  if (!assertModelDecision(model, ['mail_send_second_opinion']).allowed) return null;
  // Never in production until TypeSafe AI's written zero-data-retention terms
  // are in and JEV_PROCESSOR is verified: the flag is global, so turning it on
  // would otherwise open egress for every allowed tenant at once.
  if (isProductionAppEnv(env) || env.VERCEL_ENV?.trim().toLowerCase() === 'production') return null;
  // The env first: an unconfigured deploy never reads the flag.
  if (!env[SECOND_OPINION_ENV.apiKey]?.trim()) return null;
  const policy = readSecondOpinionPolicy(env);
  if (!policy) return null;
  return (await isEnabled('mail_jev_second_opinion', flags)) ? policy : null;
}

/** The flags the rules left after sign-offs, as fullScreenFields computed them. */
export type LeftFlags = {
  /** Promissory hits the sender did not sign off. */
  promissory: ScreenHit[];
  /** Every MNPI hit (sign-offs never cover MNPI). */
  mnpi: ScreenHit[];
  /** Whether the cross-field MNPI check fired over all screened fields. */
  crossFieldMnpi: boolean;
};

const normalized = (text: string) => text.replace(/\s+/g, ' ').trim();

/**
 * The screened fields other than one subject and one body (HTML text,
 * attachment names and content). An HTML text that reads exactly as the body,
 * whitespace aside, is the content Jev sees and does not count as other: the
 * composer sends both for every rich-text email.
 */
export function otherFields(fields: string[], subject: string, body: string): string[] {
  const rest = [...fields];
  for (const own of [subject, body]) {
    const at = rest.indexOf(own);
    if (at >= 0) rest.splice(at, 1);
  }
  const bodyText = normalized(body);
  return rest.filter((field) => normalized(field) !== bodyText);
}

/**
 * Whether Jev's read could speak for every flag left. Jev reads the subject
 * and body only (what the eval measured), so it may be asked only when NO
 * other screened field (HTML-only text, an attachment name or attachment
 * content) carries any rule hit at all. Hits are keyed by their term, so
 * comparing keys would let a benign "guarantee" in the body vouch for a
 * risky one in an attachment (PR #502 review). Every left hit must also be
 * in the subject or body, and any cross-field MNPI must be explained by the
 * subject and body alone.
 */
export function coveredBySubjectAndBody(left: LeftFlags, subject: string, body: string, fields: string[]): boolean {
  const others = otherFields(fields, subject, body);
  if (others.some((field) => findScreenHits(field).length > 0)) return false;
  // The subject, the body and any HTML copy of the body: a copy may break a
  // term across lines, which changes its key, not its meaning.
  const own = [subject, body, ...fields.filter((field) => !others.includes(field))];
  const keys = new Set(own.flatMap((field) => findScreenHits(field)).map((h) => h.key));
  if (![...left.promissory, ...left.mnpi].every((h) => keys.has(h.key))) return false;
  if (!left.crossFieldMnpi) return true;
  // The cross-field MNPI terms over every field must all appear across the
  // subject and body alone: a figure in an attachment plus context in the
  // body is a combination Jev never sees.
  const allMnpi = findScreenHits(fields.join('\n\n')).filter((h) => h.kind === 'mnpi').map((h) => h.key);
  const ownMnpi = new Set(findScreenHits([subject, body].join('\n\n')).filter((h) => h.kind === 'mnpi').map((h) => h.key));
  return crossFieldMnpiHold([subject, body]) !== null && allMnpi.every((key) => ownMnpi.has(key));
}

/** Pure decision over Jev's read: both probabilities below the threshold clear. */
export function decideSecondOpinion(read: JevRead, threshold: number): 'cleared' | 'kept' | 'error' {
  if (!read.ok) return 'error';
  return read.promissory < threshold && read.mnpi < threshold ? 'cleared' : 'kept';
}

export type SecondOpinionRequest = {
  subject: string;
  body: string;
  /** The model gate's decision for 'mail_send_second_opinion' (#339); Jev's call asserts it. */
  model: ModelCallDecision;
  /** Lazily resolved: only a send the rules flagged pays for the check. */
  gate: () => Promise<SecondOpinionPolicy | null>;
};

export type SecondOpinionResult = {
  record: SecondOpinionRecord;
  /** The ledger line for a call that got a reply; null when nothing was billed. */
  ai: { model: string; costUsd: number | null } | null;
};

/**
 * Ask Jev about the flags the rules left. null = the feature is off for this
 * call (nothing to record). Never throws: any failure is outcome 'error'.
 */
export async function secondOpinionOn(
  request: SecondOpinionRequest,
  left: LeftFlags,
  fields: string[] = [request.subject, request.body],
): Promise<SecondOpinionResult | null> {
  const hasPromissory = left.promissory.length > 0;
  const hasMnpi = left.mnpi.length > 0 || left.crossFieldMnpi;
  if (!hasPromissory && !hasMnpi) return null;

  let policy: SecondOpinionPolicy | null;
  try {
    policy = await request.gate();
  } catch {
    policy = null;
  }
  if (!policy) return null;

  const record = (outcome: SecondOpinionOutcome, clearedReasons: string[] = []): SecondOpinionRecord => ({
    outcome,
    threshold: policy.threshold,
    clearedReasons,
  });
  if (hasMnpi && policy.clears === 'promissory_only') return { record: record('skipped'), ai: null };
  if (!coveredBySubjectAndBody(left, request.subject, request.body, fields)) return { record: record('skipped'), ai: null };

  let read: JevRead;
  try {
    read = await jevRiskRead({ subject: request.subject, body: request.body }, request.model);
  } catch {
    read = { ok: false, code: 'http', latencyMs: 0 };
  }
  // A reply that came back but could not be read was still a paid call: its
  // cost is unknown, not free.
  const ai = read.ok
    ? { model: JEV_MODEL, costUsd: read.costUsd }
    : read.code === 'unreadable'
      ? { model: JEV_MODEL, costUsd: null }
      : null;
  const outcome = decideSecondOpinion(read, policy.threshold);
  const cleared =
    outcome === 'cleared' ? [...(hasPromissory ? [PROMISSORY_FLAG] : []), ...(hasMnpi ? [MNPI_FLAG] : [])] : [];
  return { record: record(outcome, cleared), ai };
}
