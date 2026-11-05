// The rule detector, rules/v1 (#173 G-07 slice 3a, design R7). Pure: it reads one quote-stripped, normalized
// message body and its sent time, and returns dated milestone facts with sentence offsets. It imports no model
// client, sends nothing anywhere and writes no output of any kind; tests/discovery-detect-fence.test.ts pins
// that for this whole directory. It favours precision over recall:
// - a wrapped "On <date> <name>" / "<address> wrote:" opener cuts the body there (ingestion only cuts the
//   one-line form, thread T-10);
// - a sentence is skipped for a question, a negation, a plan or future word, a conditional or time word, a
//   comparison word, a request or an imperative, or a refuted, hedged or template statement;
// - a rule matches only in two fixed clause orders, with its noun and verb at most three words apart (an
//   auxiliary counts, and a name such as "Project Kestrel" is one word) and no clause break between them;
// - closed, announced and the NDA types are out of v1. A rule event places a station, never a lifecycle
//   (stage engine v2).
// The rules are data in RULES_V1. A change ships as rules/v2, which re-settles every item by version.

import type { MilestoneType } from '@/lib/discovery/milestones';

export const RULES_VERSION = 'rules/v1';

export type DetectedEvent = {
  type: MilestoneType;
  /** YYYY-MM-DD */
  occurredAt: string;
  /** The matched sentence's offsets in the body passed in. */
  spanStart: number;
  spanEnd: number;
  confidence: 0.5;
};

export type MilestoneRule = {
  readonly type: MilestoneType;
  /** Noun phrases as regex sources; a space matches any run of whitespace. Acronyms are case-sensitive. */
  readonly nouns: readonly string[];
  /** "<noun> (was|were|has been|have been|got)? <verb>" */
  readonly passiveVerbs: readonly string[];
  /** "<subject> (has|have)? <verb> (the|a|an)? <noun>" */
  readonly activeVerbs: readonly string[];
};

const SIGN = ['signed', 'executed', 'countersigned'];

export const RULES_V1: readonly MilestoneRule[] = [
  { type: 'loi_signed', nouns: ['LOIs?', '[Ll]etters? of [Ii]ntent'], passiveVerbs: SIGN, activeVerbs: SIGN },
  {
    type: 'exclusivity_granted',
    nouns: ['[Ee]xclusivity(?: [Ll]etter| [Aa]greement)?'],
    passiveVerbs: ['granted', 'signed', 'countersigned'],
    activeVerbs: ['granted', 'signed', 'countersigned'],
  },
  {
    type: 'signed',
    nouns: ['SPAs?', '[Pp]urchase [Aa]greements?', '[Mm]erger [Aa]greements?'],
    passiveVerbs: ['signed', 'executed'],
    activeVerbs: ['signed', 'executed'],
  },
  {
    type: 'bids_received',
    nouns: ['IOIs', '[Ii]ndications of [Ii]nterest', '[Bb]ids'],
    passiveVerbs: ['received', 'came in'],
    activeVerbs: ['received'],
  },
  { type: 'vdr_opened', nouns: ['VDRs?', '[Dd]ata [Rr]ooms?'], passiveVerbs: ['opened', 'went live'], activeVerbs: ['opened'] },
  {
    type: 'engagement_letter_signed',
    nouns: ['[Ee]ngagement [Ll]etters?'],
    passiveVerbs: ['signed', 'countersigned'],
    activeVerbs: ['signed', 'countersigned'],
  },
  {
    type: 'process_letter_sent',
    nouns: ['[Pp]rocess [Ll]etters?'],
    passiveVerbs: ['sent', 'went out'],
    activeVerbs: ['sent'],
  },
];

// ── Clause orders ────────────────────────────────────────────────────────────

/** One word between the noun and the verb. A comma, semicolon, colon, bracket or quote ends the run. */
const WORD = "[A-Za-z0-9][A-Za-z0-9.'’&-]*";
/** Words that break a clause, or carry tense or mood, and so may not sit between the noun and the verb. */
const BREAK =
  '(?:and|but|or|nor|which|that|who|whom|whose|where|while|whereas|although|though|because|so|then|' +
  'is|are|am|be|being|been|was|were|has|have|had|get|gets|got|getting|do|does|did|' +
  'may|might|could|can|must|will|would|should|shall|to|not|never)';
/** A run of capitalised words, a name ("Project Kestrel", "Northwind Robotics"), which counts as one word. */
const NAME = "[A-Z][A-Za-z0-9.'’&-]*(?:\\s+[A-Z][A-Za-z0-9.'’&-]*)*";
const gap = (max: number) => `(?:\\s+(?!${BREAK}\\b)(?:${NAME}|${WORD})){0,${max}}`;
/** The auxiliaries of the passive order. They count toward the three words: "has been" is two. */
const AUX_ONE = '(?:was|were|got)';
const AUX_TWO = '(?:has|have)\\s+been';
/** "signed off" approves, "signed up" enrols: neither is a signing. */
const NOT_PHRASAL = '(?!\\s+(?:off|up)\\b)';
const ws = (source: string) => source.replace(/ /g, '\\s+');
const alt = (sources: readonly string[]) => `(?:${sources.map(ws).join('|')})`;

type CompiledRule = { type: MilestoneType; passive: RegExp; active: RegExp };

const COMPILED: readonly CompiledRule[] = RULES_V1.map((rule) => ({
  type: rule.type,
  passive: new RegExp(
    `\\b${alt(rule.nouns)}\\b(?:${gap(3)}|${gap(2)}\\s+${AUX_ONE}|${gap(1)}\\s+${AUX_TWO})\\s+${alt(rule.passiveVerbs)}\\b${NOT_PHRASAL}`,
    'g',
  ),
  active: new RegExp(`\\b${alt(rule.activeVerbs)}\\b${NOT_PHRASAL}(?:\\s+(?:the|a|an))?${gap(2)}\\s+${alt(rule.nouns)}\\b`, 'g'),
}));

/** A word that makes the verb after it an adjective ("the signed LOI"), not a report that something was signed. */
const DETERMINERS = new Set(['the', 'a', 'an', 'this', 'that', 'these', 'those', 'its', 'their', 'our', 'his', 'her', 'your', 'my', 'any', 'each', 'every', 'some']);

/** The active order needs a subject: a word before the verb that is not a determiner and ends no clause. */
function hasSubject(sentence: string, verbAt: number): boolean {
  const words = sentence.slice(0, verbAt).trim().split(/\s+/).filter(Boolean);
  if (words.length > 0 && /^(?:has|have)$/i.test(words[words.length - 1])) words.pop();
  const last = words[words.length - 1];
  if (!last || /[,;:(]$/.test(last)) return false;
  return !DETERMINERS.has(last.toLowerCase());
}

/** Where the rule's verb sits in the sentence (the date nearest it is the event's), or -1 when it does not match. */
function verbAt(rule: CompiledRule, sentence: string): number {
  for (const m of sentence.matchAll(rule.passive)) return (m.index ?? 0) + m[0].length;
  for (const m of sentence.matchAll(rule.active)) {
    if (hasSubject(sentence, m.index ?? 0)) return m.index ?? 0;
  }
  return -1;
}

// ── Skip markers ─────────────────────────────────────────────────────────────

const SKIP_MARKERS: readonly RegExp[] = [
  // A question.
  /\?["'”’)\]]*$/,
  // Negation.
  /\b(?:not|never|no|nor|neither|cannot|without)\b|n['’]t\b|\bno\s+longer\b|\byet\s+to\b/i,
  // A plan or the future. "may" is lower case only, so the month (always capitalised) never trips it.
  /\b(?:will|would|should|shall|expect\w*|plan|plans|planned|planning|aim|aims|aimed|aiming|intend\w*|to\s+be|going\s+to|draft\s+of|next\s+week|pending|subject\s+to|once|target\w*)\b/i,
  /\b(?:might|could|can|must|tomorrow|scheduled|upcoming|soon|ready)\b/i,
  /\bmay\b/,
  // A condition or a time relation.
  /\b(?:if|unless|when|whenever|until|before|after|assuming|provided|in\s+case|whether)\b/i,
  // A comparison.
  /\b(?:benchmarks?|comparables?|comps|precedents?|similar(?:ly)?|like\s+the)\b/i,
  // A request ("we need the LOI signed", "let's get the SPA executed"): the thing is asked for, not reported.
  // "got" stays readable ("we got the LOI signed" reports it); "get" asks for it. "confirm" alone asks, while
  // "confirms" and "confirmed" report.
  /\b(?:needs?|needed|please|pls|kindly|let['’]s|let\s+us|ask|asks|asked|asking|confirm|await|awaiting|waiting|hope|hopes|hoped|hopefully|request|requests|requested|requesting|get|gets|getting|make\s+sure|ensure)\b/i,
  // A refuted or hedged statement: a rumour, a denial, a belief someone has yet to check.
  /\b(?:rumou?rs?|rumou?red|false|untrue|incorrect|inaccurate|denied|denies|deny|refuted|speculation|speculative|unconfirmed|allegedly|supposedly|reportedly|apparently|hypothetical(?:ly)?|suppose|imagine)\b/i,
  /\b(?:i|we)\s+(?:think|believe|guess|assume|gather|heard)\b|\bto\s+(?:check|verify|double-check)\b/i,
  // A template or an example: the wording of a sentence, not a report, often with a placeholder.
  /\b(?:template|example|e\.g\.|for\s+instance|sample|placeholder|boilerplate|wording)\b/i,
  /\[[^\]@]*\]|\{[^}@]*\}|<[A-Za-z][A-Za-z _-]*>|_{3,}/,
];

/** Verbs a sentence starts with when it gives an order ("Send the process letter", "Get the SPA executed"). */
const IMPERATIVE = new Set([
  'get', 'have', 'make', 'ensure', 'send', 'sign', 'countersign', 'execute', 'circulate', 'open', 'grant', 'confirm',
  'check', 'verify', 'remember', 'chase', 'arrange', 'prepare', 'finalise', 'finalize', 'push', 'let', 'ask', 'do',
]);

/** A sentence that opens on a bare verb, after any bullet, quote or "please", is an instruction. */
function imperative(sentence: string): boolean {
  const first = /^[\s"'“‘(\-*•\d.)]*(?:(?:please|pls|kindly)[\s,]+)?([A-Za-z]+)/i.exec(sentence)?.[1];
  return first !== undefined && IMPERATIVE.has(first.toLowerCase());
}

const skipped = (sentence: string) => imperative(sentence) || SKIP_MARKERS.some((marker) => marker.test(sentence));

// ── Sentences and the wrapped quote opener ───────────────────────────────────

/**
 * Cuts the body at a quoted-history opener: a line "On ... wrote:", or a line starting "On " (and not ending a
 * sentence) whose next line, or the one after it, ends "wrote:". Gmail wraps the opener when the name and the
 * address are long; ingestion's quote stripping matches one line only (thread T-10). The kept text is a prefix
 * of the body, so offsets into it are offsets into the body.
 */
export function cutWrappedQuoteOpener(body: string): string {
  const lines = body.split('\n');
  const endsWrote = (line: string | undefined) => line !== undefined && /wrote:\s*$/i.test(line.trim());
  let offset = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (/^On\s/.test(line)) {
      if (endsWrote(line)) return body.slice(0, offset);
      if (!/[.!?]$/.test(line)) {
        for (let j = i + 1; j <= i + 2 && j < lines.length && lines[j].trim() !== ''; j += 1) {
          if (endsWrote(lines[j])) return body.slice(0, offset);
        }
      }
    }
    offset += lines[i].length + 1;
  }
  return body;
}

/**
 * Sentence offsets, trimmed. A sentence ends at a ? followed by whitespace, whatever comes next ("Was the LOI
 * signed?\nthanks" is a question and a sign-off); at . or ! followed by whitespace and then anything but a
 * lower-case letter or a digit ("Sept. 18" and "Inc. signed" do not end one); or at a blank line.
 */
function sentences(text: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  const push = (from: number, to: number) => {
    let s = from;
    let e = to;
    while (s < e && /\s/.test(text[s])) s += 1;
    while (e > s && /\s/.test(text[e - 1])) e -= 1;
    if (e > s) out.push({ start: s, end: e });
  };
  let start = 0;
  for (const m of text.matchAll(/([.!?]*\?["'”’)\]]*)(?=\s|$)|([.!]+["'”’)\]]*)(?=\s+[^a-z0-9\s]|\s*$)|\n[ \t]*\n/g)) {
    const at = m.index ?? 0;
    push(start, m[1] || m[2] ? at + m[0].length : at);
    start = at + m[0].length;
  }
  push(start, text.length);
  return out;
}

// ── Dates ────────────────────────────────────────────────────────────────────

type Ymd = { y: number; m: number; d: number };

const MONTH_NUMBER: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5, june: 6, jun: 6,
  july: 7, jul: 7, august: 8, aug: 8, september: 9, sept: 9, sep: 9, october: 10, oct: 10, november: 11, nov: 11,
  december: 12, dec: 12,
};
// Capitalised only: "may" the modal is not a month. Full names come first, so "September" is never read as "Sep".
const MONTH =
  '(January|February|March|April|May|June|July|August|September|October|November|December|Sept|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\\b\\.?';
const DAY = '(\\d{1,2})(?:st|nd|rd|th)?';

const pad = (n: number, width: number) => String(n).padStart(width, '0');
const iso = ({ y, m, d }: Ymd) => `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`;
const fromUtc = (t: Date): Ymd => ({ y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() });

function ymd(y: number, m: number, d: number): Ymd | null {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? { y, m, d } : null;
}

const monthOf = (name: string) => MONTH_NUMBER[name.toLowerCase()] ?? 0;

/** A day and month without a year: the sent year, or the year before when that date is after the sent date. */
function inferYear(m: number, d: number, sent: Ymd): Ymd | null {
  const sameYear = ymd(sent.y, m, d);
  if (!sameYear || iso(sameYear) <= iso(sent)) return sameYear;
  return ymd(sent.y - 1, m, d);
}

type DateForm = { re: RegExp; read: (m: RegExpMatchArray, sent: Ymd) => Ymd | null };

/** In precedence order: at the same position an earlier form wins ("6 May 2026" over "6 May"). */
const DATE_FORMS: readonly DateForm[] = [
  { re: new RegExp(`\\b${DAY}\\s+${MONTH},?\\s+(\\d{4})\\b`, 'g'), read: (m) => ymd(Number(m[3]), monthOf(m[2]), Number(m[1])) },
  { re: new RegExp(`\\b${MONTH}\\s+${DAY},?\\s+(\\d{4})\\b`, 'g'), read: (m) => ymd(Number(m[3]), monthOf(m[1]), Number(m[2])) },
  { re: /\b(\d{4})-(\d{2})-(\d{2})(?!\d)/g, read: (m) => ymd(Number(m[1]), Number(m[2]), Number(m[3])) },
  { re: new RegExp(`\\b${DAY}\\s+${MONTH}`, 'g'), read: (m, sent) => inferYear(monthOf(m[2]), Number(m[1]), sent) },
  { re: new RegExp(`\\b${MONTH}\\s+${DAY}\\b`, 'g'), read: (m, sent) => inferYear(monthOf(m[1]), Number(m[2]), sent) },
  {
    re: /\b(today|yesterday)\b/gi,
    read: (m, sent) => (m[1].toLowerCase() === 'today' ? sent : fromUtc(new Date(Date.UTC(sent.y, sent.m - 1, sent.d - 1)))),
  },
  // A relative period names no day: the earliest day it can mean, so the event is never dated after it happened.
  // "last week" is seven days before the sent day, "last month" the first of the month before, "last year" the
  // first of January before.
  {
    re: /\blast\s+(week|month|year)\b/gi,
    read: (m, sent) => {
      const unit = m[1].toLowerCase();
      if (unit === 'week') return fromUtc(new Date(Date.UTC(sent.y, sent.m - 1, sent.d - 7)));
      if (unit === 'month') return fromUtc(new Date(Date.UTC(sent.y, sent.m - 2, 1)));
      return ymd(sent.y - 1, 1, 1);
    },
  },
];

/**
 * The date of the verb's event: the first date after the verb ("signed on 18 September"), else the nearest one
 * before it ("On 18 September the LOI was signed"), so a second date in the sentence ("dated 1 September") does not
 * win by sitting further left. Forms overlapping an earlier-starting date are not read again, and at one position
 * the form order decides. Numeric d/m forms are ambiguous and fall back to the sent date, as does no date.
 */
function dateOf(sentence: string, sent: Ymd, verb: number): string {
  const found: Array<{ at: number; end: number; rank: number; value: Ymd }> = [];
  DATE_FORMS.forEach((form, rank) => {
    for (const m of sentence.matchAll(form.re)) {
      const value = form.read(m, sent);
      if (value) found.push({ at: m.index ?? 0, end: (m.index ?? 0) + m[0].length, rank, value });
    }
  });
  found.sort((a, b) => a.at - b.at || a.rank - b.rank);
  const dates: typeof found = [];
  for (const f of found) if (dates.length === 0 || f.at >= dates[dates.length - 1].end) dates.push(f);
  const after = dates.find((d) => d.at >= verb);
  const before = dates.filter((d) => d.end <= verb).at(-1);
  const best = after ?? before;
  return iso(best ? best.value : sent);
}

/**
 * The sent day as the sender saw it: the local date at the offset `sentAt` carries ("2026-09-18T22:30:00-04:00" is
 * the 18th), so late-evening mail is not read a day ahead. A time in UTC (Z, or no offset) is read in UTC: the
 * ingested sent time keeps no sender offset today, so "today" in such mail is the UTC day.
 */
function sentDay(sentAt: string, sentMs: number): Ymd {
  const offset = /([+-])(\d{2}):?(\d{2})$/.exec(sentAt.trim());
  if (!offset) return fromUtc(new Date(sentMs));
  const minutes = (offset[1] === '-' ? -1 : 1) * (Number(offset[2]) * 60 + Number(offset[3]));
  return fromUtc(new Date(sentMs + minutes * 60_000));
}

// ── The detector ─────────────────────────────────────────────────────────────

/**
 * Milestones a body reports as having happened, one event per matching rule per sentence, in body order.
 * `body` is quote-stripped normalized text; `sentAt` is the message's sent time (ISO 8601), whose local day stands
 * in for "today" and for a sentence with no date. An unparseable `sentAt` yields no events.
 */
export function detectMilestones(body: string, sentAt: string): DetectedEvent[] {
  const sentMs = Date.parse(sentAt);
  if (!Number.isFinite(sentMs)) return [];
  const sent = sentDay(sentAt, sentMs);
  const text = cutWrappedQuoteOpener(body);
  const events: DetectedEvent[] = [];
  const seen = new Set<string>();
  for (const { start, end } of sentences(text)) {
    const sentence = text.slice(start, end);
    if (skipped(sentence)) continue;
    for (const rule of COMPILED) {
      const key = `${rule.type}:${start}`;
      if (seen.has(key)) continue;
      const verb = verbAt(rule, sentence);
      if (verb < 0) continue;
      seen.add(key);
      events.push({ type: rule.type, occurredAt: dateOf(sentence, sent, verb), spanStart: start, spanEnd: end, confidence: 0.5 });
    }
  }
  return events;
}
