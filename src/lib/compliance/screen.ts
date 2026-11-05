import type { ComplianceCheckResult } from '../api/types';

/**
 * Deterministic compliance screening for outgoing messages.
 *
 * Three verdicts:
 *   compliant — passes all checks.
 *   hold      — matched MNPI keyword OR dollar figure in valuation context;
 *               needs supervisory review before send.
 *   blocked   — matched a promissory pattern (forward-looking commitment
 *               language to a counterparty); must be rewritten.
 *
 * Priority: promissory wins over MNPI (blocked > hold).
 *
 * Ported from intelibank-sandbox/lib/compliance/screen.ts (2026-05-20).
 * Rules verbatim; surface adapted to A's ComplianceCheckResult shape.
 * Governance: ADR-0003 (Compliance verdict shape: three-state with
 * rewrite suggestions).
 */

/**
 * Our own delivery or timing ("send you the revised deck", "get back to you",
 * "keep you updated"). A promise, commitment or word given about one of these
 * is a service commitment, not a deal term, so it is not promissory (tuned
 * 2026-09-30 against the false-positive corpus, PR #294). It is an allowlist:
 * only a known document to send, or a known way of staying in touch, escapes,
 * and only when the rest of the sentence names no deal term, number or
 * currency. Anything else, including "deliver", "share the upside" or "call
 * the deal off", keeps the flag. The sentence must also end at the benign
 * clause: only an addressee ("to you"), a topic ("on the diligence
 * questions") or a time ("tomorrow", "by Friday noon", "as soon as the round
 * closes") may follow, so "follow up and nobody loses out" keeps the flag
 * (Guillermo's review of PR #304).
 */
const DOCUMENT = String.raw`(?:deck|materials?|slides|presentation|agenda|notes|summary|update|invite|documents?|docs|files?|draft|cim|teaser|nda|comments|markup|questions|timeline|schedule)`;
const OWN_ACTION = String.raw`(?:(?:send(?:ing)?|shar(?:e|ing)|circulat(?:e|ing))\s+(?:you\s+)?(?:(?:the|our|a|an|this|that)\s+)?(?:(?:revised|updated|latest|final|draft|new|full)\s+)?${DOCUMENT}|get(?:ting)?\s+back\s+to\s+you|follow(?:ing)?\s+up|revert(?:ing)?\s+to\s+you|(?:respond(?:ing)?|repl(?:y|ying))\s+to\s+(?:you|your)|call(?:ing)?\s+you|keep(?:ing)?\s+you\s+(?:updated|posted|informed)|updat(?:e|ing)\s+you)\b`;
/** Words that make a delivery promise about the deal itself. Plurals included. */
const DEAL_TERM = String.raw`(?:offers?|pric(?:e|es|ing)|bids?|ranges?|valuations?|terms?|seats?|roles?|earn[\s-]?outs?|indemnit(?:y|ies)|premiums?|multiples?|considerations?|exclusiv(?:e|ity)|equity|stakes?|proceeds|upside|bonus(?:es)?|retention|jobs?|headcount|board|closing|loi|spa|numbers?|figures?|returns?|outcomes?|deal|merger|acquisition|announce\w*|walk-away|floor|ceiling|model|ebitda|margin|cap\s+table|no-shop)`;
/** After our own action: the rest of the sentence, across line breaks, must be free of these. */
const CLEAN_REST = String.raw`(?![^.!?]*(?:\b${DEAL_TERM}\b|\d|[$€£%]))`;
const DAY = String.raw`(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tonight|tomorrow)(?:\s+(?:morning|afternoon|evening|noon))?`;
/** A process event our own action waits for ("once the second round closes"). A closed list: a free clause could carry a promise ("once your team is safe"). */
const EVENT = String.raw`(?:(?:the\s+)?(?:(?:first|second|final|next)\s+)?(?:round|call|meeting|review|session|data\s+room)\s+(?:closes|ends|opens|is\s+(?:over|done)|wraps\s+up)|(?:we|i)\s+(?:hear\s+back|know\s+more)|(?:legal|counsel)\s+signs?\s+off)`;
/** A time for our own action. */
const WHEN = String.raw`(?:${DAY}|(?:this|next)\s+(?:morning|afternoon|evening|week)|next\s+(?:monday|tuesday|wednesday|thursday|friday)|later\s+(?:today|this\s+week)|shortly|soon|asap|as\s+soon\s+as\s+possible|(?:by|on|before)\s+(?:${DAY}|(?:the\s+)?end\s+of\s+(?:the\s+)?(?:day|week)|eod|cob)|(?:as\s+soon\s+as|once|when)\s+${EVENT})`;
const TOPIC = String.raw`(?:on|about|regarding)\s+(?:the|your|our)\s+(?:(?:diligence|revised|updated|latest|final|draft|open|outstanding)\s+)?${DOCUMENT}`;
/** After our own action: nothing but an addressee, a topic or a time, then the end of the sentence. */
const BENIGN_TAIL = String.raw`(?:\s+(?:(?:to|with)\s+you|${TOPIC}|${WHEN}))*\s*(?:[.!?](?:\s|$)|$)`;

const PROMISSORY_PATTERNS: { rx: RegExp; rewrite: string }[] = [
  {
    rx: /\b(i|we)\s+(guarantee|guaranteed|guaranteeing)\b/i,
    rewrite:
      'Replace "guarantee" with a non-binding alternative: "we believe / we expect to / our intent is".',
  },
  {
    rx: /\bguaranteed?\s+(board\s+seat|role|position|outcome|return)/i,
    rewrite:
      'Avoid offering a guaranteed role or outcome to a counterparty pre-close. Frame as a discussion point, not a commitment.',
  },
  {
    rx: new RegExp(String.raw`\b(i|we)\s+promise\b(?!\s+to\s+${OWN_ACTION}${CLEAN_REST}${BENIGN_TAIL})`, 'i'),
    rewrite:
      'Replace "promise" with "intend to" or "expect to" so the language is not promissory.',
  },
  {
    rx: /\b(can|could)\s+we\s+promise\b/i,
    rewrite:
      'Asking whether to promise a counterparty something is itself promissory framing. Rephrase as a discussion of terms, not a commitment.',
  },
  {
    rx: new RegExp(String.raw`\b(i|we)\s+commit\s+to\b(?!\s+${OWN_ACTION}${CLEAN_REST}${BENIGN_TAIL})`, 'i'),
    rewrite:
      'Replace "commit to" with "are working toward" or "intend to" pre-signing.',
  },
  {
    rx: new RegExp(
      String.raw`\byou\s+have\s+(my|our)\s+word\b(?!\s+(?:that\s+)?(?:i|we)(?:\s+will|['’]ll)\s+${OWN_ACTION}${CLEAN_REST}${BENIGN_TAIL})`,
      'i',
    ),
    rewrite:
      'Personal-word commitments to a counterparty are promissory. Remove and route through advisors.',
  },
];

const MNPI_KEYWORDS = [
  'internal valuation',
  'internal model',
  'valuation model',
  'deal floor',
  'price floor',
  'reservation price',
  'walk-away',
  'mnpi',
  'material non-public',
  'board minutes',
  'draft 10-',
  'unannounced',
];

/**
 * Everyday uses of an MNPI keyword ("a walk-away success", "an unannounced
 * visit"), kept deliberately narrow (tuned 2026-09-30, PR #294 corpus). Any
 * other use, such as "our walk-away price" or "unannounced restructuring",
 * still holds.
 */
const EVERYDAY_USE: Record<string, RegExp> = {
  'walk-away': /walk-away\s+success\b/g,
  unannounced: /unannounced\s+(?:visit|visits|visitor|visitors|guest|guests|drop-in|drop-by)\b/g,
};

/** $510M, $1.2B, 510M, etc. Present alongside valuation context = MNPI signal. */
const DOLLAR_FIGURE_RX =
  /\$?\s?\d{1,4}(?:[.,]\d+)?\s?(?:m|mm|b|bn|million|billion)\b/i;
const MNPI_CONTEXT_RX =
  /\b(floor|ceiling|valuation|model|ebitda|margin|range|target\s+price|cap\s+table|term\s+sheet)\b/i;

export const PROMISSORY_FLAG =
  'Promissory language to a counterparty. Rewrite suggested before send.';
export const MNPI_FLAG = 'Contains MNPI. Routed to supervisory queue, not blocked.';

export function screenMessage(body: string): ComplianceCheckResult {
  // Derived from findScreenHits — ONE walk over the patterns, so the send
  // gate and the composer's per-term UI (#155) can never drift: the first
  // promissory hit blocks (its note is the rewrite, preserving pattern
  // order), any hit at all holds, otherwise compliant.
  const hits = findScreenHits(body);
  const promissory = hits.find((h) => h.kind === 'promissory');
  if (promissory) {
    return { verdict: 'blocked', reasons: [PROMISSORY_FLAG], rewrite: promissory.note };
  }
  if (hits.length > 0) {
    return { verdict: 'hold', reasons: [MNPI_FLAG] };
  }
  return { verdict: 'compliant', reasons: [] };
}

/**
 * The rule layer's findings on a message's fields ([subject, body]), as the
 * send path applies it: each field on its own, plus the MNPI check across
 * fields. One readable reason per hit ("promissory: we guarantee"); empty when
 * the rules find nothing. Shared by the false-positive measurement and the
 * screening of incoming mail, so both read exactly what a send would.
 */
export function ruleLayerReasons(fields: string[]): string[] {
  const reasons = fields.flatMap((field) => findScreenHits(field).map((hit) => `${hit.kind}: ${hit.term}`));
  if (reasons.length === 0 && crossFieldMnpiHold(fields)) reasons.push('mnpi: across subject and body');
  return reasons;
}

/**
 * Cross-field MNPI check. An MNPI signal may legitimately straddle fields —
 * a subject naming the valuation context ("Project Atlas valuation update")
 * and a body carrying the figure ("we will not go below $510M") read together
 * as a leak, and screening the fields only in isolation would send it clean.
 * Only the mnpi hits of the joined text are consulted: the promissory \s+
 * patterns must NOT cross the field seam (they mint phantom phrases that
 * exist in no field — the seam bug).
 */
export function crossFieldMnpiHold(fields: string[]): ComplianceCheckResult | null {
  if (fields.length < 2) return null;
  const hits = findScreenHits(fields.join('\n\n'));
  if (hits.some((h) => h.kind === 'mnpi')) {
    return { verdict: 'hold', reasons: [MNPI_FLAG] };
  }
  return null;
}

/**
 * A single Layer 1 hit, addressable in the UI: the composer underlines the
 * term, explains the rule, and lets the sender sign off on it (#155). Built
 * from the SAME patterns as screenMessage — one source of truth, so what the
 * UI flags is exactly what the send gate would act on.
 */
export type ScreenHit = {
  /** The matched text, as found. */
  term: string;
  /** Normalized identity — acknowledgment (override) is keyed on this. */
  key: string;
  kind: 'promissory' | 'mnpi';
  /** Why the term is flagged / how to fix it, for the tooltip. */
  note: string;
};

export function findScreenHits(body: string): ScreenHit[] {
  const text = (body ?? '').trim();
  if (!text) return [];

  const hits: ScreenHit[] = [];
  const seen = new Set<string>();
  const push = (term: string, kind: ScreenHit['kind'], note: string) => {
    const key = term.trim().toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    hits.push({ term: term.trim(), key, kind, note });
  };

  for (const { rx, rewrite } of PROMISSORY_PATTERNS) {
    const flags = rx.flags.includes('g') ? rx.flags : `${rx.flags}g`;
    for (const match of text.match(new RegExp(rx.source, flags)) ?? []) {
      push(match, 'promissory', rewrite);
    }
  }

  const lower = text.toLowerCase();
  for (const keyword of MNPI_KEYWORDS) {
    if (!lower.includes(keyword)) continue;
    const everyday = EVERYDAY_USE[keyword];
    // Flag unless every occurrence is the everyday sense.
    if (everyday && lower.split(keyword).length - 1 === (lower.match(everyday) ?? []).length) continue;
    push(keyword, 'mnpi', MNPI_FLAG);
  }
  if (MNPI_CONTEXT_RX.test(text)) {
    const flags = DOLLAR_FIGURE_RX.flags.includes('g')
      ? DOLLAR_FIGURE_RX.flags
      : `${DOLLAR_FIGURE_RX.flags}g`;
    for (const figure of text.match(new RegExp(DOLLAR_FIGURE_RX.source, flags)) ?? []) {
      push(figure, 'mnpi', 'A dollar figure in valuation context reads as MNPI.');
    }
  }

  return hits;
}
