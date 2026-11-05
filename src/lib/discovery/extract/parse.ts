// Parses a model's milestone reply against the mail it read. Every milestone
// must quote a sentence that exists in the body: the quote is located, its
// offsets kept, and the quote itself dropped, so a model can never put words in
// a banker's mouth and nothing derived from mail rests in the output.

import { extractJsonPayload } from '@/lib/modelGateway/json';

import { MILESTONE_TYPES, type MilestoneType } from '../milestones';

export type ParsedMilestone = {
  type: MilestoneType;
  occurredAt: string;
  spanStart: number;
  spanEnd: number;
  confidence: number;
};
export type ParseError = 'not_json' | 'schema' | 'span_not_found';

const MAX_QUOTE = 600;

function isIsoDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * Finds the quote in the body: exact first, then with every whitespace run
 * collapsed on both sides and offsets mapped back to the original body.
 */
function findSpan(body: string, quote: string): [number, number] | null {
  const exact = body.indexOf(quote);
  if (exact >= 0) return [exact, exact + quote.length];

  const collapsedQuote = quote.trim().replace(/\s+/g, ' ');
  if (!collapsedQuote) return null;
  let collapsed = '';
  const offsets: number[] = []; // offsets[i] = index in body of collapsed[i]
  let inSpace = false;
  for (let i = 0; i < body.length; i++) {
    if (/\s/.test(body[i])) {
      if (!inSpace && collapsed.length > 0) {
        collapsed += ' ';
        offsets.push(i);
      }
      inSpace = true;
    } else {
      collapsed += body[i];
      offsets.push(i);
      inSpace = false;
    }
  }
  const at = collapsed.indexOf(collapsedQuote);
  if (at < 0) return null;
  const last = at + collapsedQuote.length - 1;
  return [offsets[at], offsets[last] + 1];
}

function dedupeBy<T>(list: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  return list.filter((t) => {
    const k = key(t);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function parseMilestoneReply(
  text: string,
  body: string,
): { ok: true; events: ParsedMilestone[] } | { ok: false; error: ParseError } {
  let value: unknown;
  try {
    value = JSON.parse(extractJsonPayload(text));
  } catch {
    return { ok: false, error: 'not_json' };
  }
  const list = (value as { milestones?: unknown } | null)?.milestones;
  if (!Array.isArray(list)) return { ok: false, error: 'schema' };
  const out: ParsedMilestone[] = [];
  for (const raw of list) {
    if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'schema' };
    const m = raw as Record<string, unknown>;
    if (!MILESTONE_TYPES.includes(m.type as MilestoneType)) return { ok: false, error: 'schema' };
    if (typeof m.occurred_on !== 'string' || !isIsoDay(m.occurred_on)) return { ok: false, error: 'schema' };
    if (typeof m.quote !== 'string' || !m.quote.trim() || m.quote.length > MAX_QUOTE) {
      return { ok: false, error: 'schema' };
    }
    const confidence = typeof m.confidence === 'number' ? m.confidence : NaN;
    if (!(confidence >= 0 && confidence <= 1)) return { ok: false, error: 'schema' };
    const span = findSpan(body, m.quote);
    if (!span) return { ok: false, error: 'span_not_found' };
    out.push({
      type: m.type as MilestoneType,
      occurredAt: m.occurred_on,
      spanStart: span[0],
      spanEnd: span[1],
      confidence,
    });
  }
  return { ok: true, events: dedupeBy(out, (e) => `${e.type}:${e.spanStart}`) };
}
