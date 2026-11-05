/**
 * The Ignatious Communications Risk Lexicon as SIGNALS (#163).
 *
 * The parent documents are explicit: "this is not a blocking list", "a
 * keyword match is evidence to review, never a conclusion about intent",
 * "a tier is a ceiling, not an assessment". So lexicon hits NEVER set a
 * deterministic verdict — the promissory/MNPI rules in screen.ts remain the
 * only rule-layer verdict-setters. Hits are handed to the AI layer as
 * context (it stays escalate-only) and recorded in the screen audit with
 * the lexicon VERSION, so every verdict cites the vocabulary it enforced
 * while formal adoption remains a CCO decision (the lexicon is a working
 * draft, not yet adopted policy).
 */

import {
  LEXICON_CATEGORIES,
  LEXICON_ENTRIES,
  LEXICON_VERSION,
  type LexiconTier,
} from './lexicon.generated';

export { LEXICON_CATEGORIES, LEXICON_VERSION };
export type { LexiconTier };

export type LexiconHit = {
  phrase: string;
  tier: LexiconTier;
  /** Library category (1..24) — the gloss that makes the alert explainable. */
  category: number;
  /** Phrase family (1..228). */
  family: number;
};

/**
 * Where each tier is allowed to surface — the standard's own handling rules,
 * made code (#163 slice 5):
 *   Tier 1 "Urgent": explicit instruction or corroborated conduct → the
 *     sender sees it pre-send (advisory underline + strip), the AI weighs
 *     it, the audit records it.
 *   Tier 2 "Elevated": ambiguous language, "review with linked context…
 *     coaching is often the right outcome" → supervision-side, not a
 *     pre-send nudge to the sender; the AI weighs it, the audit records it.
 *   Tier 3 "Contextual": ordinary business language, "do not escalate or
 *     coach on these alone — doing so destroys the credibility of the whole
 *     system" → analytics only: the audit records it, nothing else sees it
 *     (an escalate-only judge fed a T3 signal IS a coaching nudge).
 */
export const LEXICON_TIER_SURFACE: Readonly<
  Record<LexiconTier, { sender: boolean; ai: boolean; audit: boolean }>
> = {
  1: { sender: true, ai: true, audit: true },
  2: { sender: false, ai: true, audit: true },
  3: { sender: false, ai: false, audit: true },
};

/** Short category labels for the composer strip — the full names (up to
 *  90 characters) are for the prompt and the audit. Hand-kept; the test
 *  suite pins that every category has one. */
export const LEXICON_CATEGORY_SHORT: Readonly<Record<number, string>> = {
  1: 'Off-channel',
  2: 'MNPI',
  3: 'Expert networks',
  4: 'Market conduct',
  5: 'Antitrust',
  6: 'Process integrity',
  7: 'Conflicts',
  8: 'Misleading claims',
  9: 'Offering conduct',
  10: 'Research independence',
  11: 'Gifts and bribery',
  12: 'AML and sanctions',
  13: 'Books and records',
  14: 'Investigations',
  15: 'Workplace conduct',
  16: 'Privacy and data',
  17: 'Recording',
  18: 'Inadvertent commitment',
  19: 'Departing employees',
  20: 'Reputation and media',
  21: 'Threats and safety',
  22: 'AI governance',
  23: 'Licensing',
  24: 'Privilege',
};

export function lexiconCategoryName(category: number): string {
  return LEXICON_CATEGORIES[category] ?? `Category ${category}`;
}

/** How many signals travel to the AI prompt — most severe first. Volume
 *  beyond this adds noise, not information. */
export const LEXICON_SIGNAL_CAP = 12;

/** The audit keeps up to this many signals PER TIER, so a message stuffed
 *  with Tier-1 phrases can never push a Tier-3 hit out of its only surface
 *  (Tier 3 is audit-only by doctrine — see LEXICON_TIER_SURFACE). */
export const LEXICON_AUDIT_CAP_PER_TIER = LEXICON_SIGNAL_CAP;

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * One matcher per usable entry, compiled once.
 *
 * - Matching is case-insensitive with word-ish boundaries on both sides
 *   (lookarounds, because entries like "#1" start outside \w).
 * - Bracketed placeholders ("agree a comp band with [competitor]") match on
 *   the literal words BEFORE the bracket, if that prefix is at least two
 *   words — matching the placeholder itself would be guessing.
 * - Entries whose usable literal is a single generic word stay in the
 *   library but only match as whole words; prose descriptors (no such
 *   entries match real sentences) are harmless no-ops.
 */
const MATCHERS: ReadonlyArray<{ entry: LexiconHit; rx: RegExp }> = LEXICON_ENTRIES.flatMap(
  (entry) => {
    // A trailing ellipsis is an open-ended template, exactly like a bracket:
    // "buy ahead of…" means "buy ahead of <anything>" — the ellipsis itself
    // never appears in real mail, so it must not be part of the pattern.
    const unterminated = entry.phrase.replace(/(?:\.\.\.|…)+\s*$/, '');
    const bracketAt = unterminated.indexOf('[');
    let literal = (bracketAt >= 0 ? unterminated.slice(0, bracketAt) : unterminated).trim();
    if (bracketAt >= 0 && literal.split(/\s+/).length < 2) return [];
    literal = literal.replace(/\s+/g, ' ');
    if (!literal) return [];
    // Slash groups are alternations ("agree the price/fee/spread" fires on
    // any one of the three), never a literal slash requirement.
    const pattern = literal
      .split(' ')
      .map((token) =>
        token.includes('/')
          ? `(?:${token
              .split('/')
              .filter(Boolean)
              .map(escapeRegex)
              .join('|')})`
          : escapeRegex(token),
      )
      .join('\\s+');
    return [
      {
        entry: { phrase: entry.phrase, tier: entry.tier, category: entry.category, family: entry.family },
        rx: new RegExp(`(?<![\\w])${pattern}(?![\\w])`, 'i'),
      },
    ];
  },
);

/** Every lexicon signal present in the text — deduped, most severe tier
 *  first, alphabetical within a tier. Uncapped; callers cap for transport.
 *  Input is normalized the same way the extractor normalizes the phrases:
 *  smart quotes (Outlook/iOS/Gmail defaults) must not defeat the 76
 *  apostrophe-bearing entries. */
export function findLexiconHits(text: string): LexiconHit[] {
  return findLexiconMatches(text).map(({ phrase, tier, category, family }) => ({
    phrase,
    tier,
    category,
    family,
  }));
}

/**
 * The ONE normalization the matcher and the composer's underline share.
 * INVARIANT: every replacement is 1:1 length-preserving — the composer's
 * highlight-offset math walks the un-normalized DOM text and depends on it.
 * NBSP folds to a plain space (pasted mail, &nbsp; in contentEditable);
 * smart quotes (Outlook/iOS/Gmail defaults) fold to straight ones so the 76
 * apostrophe-bearing entries keep matching.
 */
export function normalizeLexiconText(text: string): string {
  return text
    .replace(/ /g, ' ')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"');
}

export type LexiconMatch = LexiconHit & {
  /** The text the matcher actually hit (a slash-group entry like
   *  "agree the price/fee/spread" matches on ONE alternative), with its
   *  whitespace collapsed to single spaces for display and searching. */
  match: string;
};

/** Like findLexiconHits, but carrying the matched text — the composer's
 *  advisory underline needs the string that appears in the message, not the
 *  library phrase (#163 slice 2). Same normalization, order, and dedupe. */
export function findLexiconMatches(text: string): LexiconMatch[] {
  if (!text) return [];
  const normalized = normalizeLexiconText(text);
  const matches: LexiconMatch[] = [];
  for (const { entry, rx } of MATCHERS) {
    const m = rx.exec(normalized);
    // \s+ in the patterns matches newlines and stray whitespace; collapse
    // them so the match renders on one line and is findable as a needle.
    if (m) matches.push({ ...entry, match: m[0].replace(/\s+/g, ' ') });
  }
  return matches.sort((a, b) => a.tier - b.tier || a.phrase.localeCompare(b.phrase));
}

/** The audit-detail fields for a screen's lexicon evidence — ONE builder so
 *  every AUDIT_ACTION.SCREEN row cites the enforced vocabulary identically. */
export function lexiconAuditFields(lexicon: {
  version: string;
  signals: LexiconHit[];
}): Record<string, unknown> {
  return {
    lexiconVersion: lexicon.version,
    ...(lexicon.signals.length ? { lexiconSignals: lexicon.signals } : {}),
  };
}
