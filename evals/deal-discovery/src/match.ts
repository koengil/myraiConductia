// Candidate <-> true deal (handoff 10: "match by parties/codename/time
// overlap"), gated by the candidate's evidence (review item 2).
//
// A candidate qualifies for a deal when all three hold:
//   - their dates are compatible: the candidate's [firstSeenAt, lastSeenAt]
//     overlaps the deal's window widened by MATCH_TUNING.windowToleranceDays
//     on each side (a missing date on either side is compatible);
//   - it names the deal, or shares a party with it. It names the deal when
//     its codename guess or proposed name is the deal's codename, its name, a
//     codename derived from its name, or an alias (review item 5). A party is
//     shared by mail domain or by company name;
//   - its evidence says so: at least MATCH_TUNING.minEvidenceShare of its
//     labeled evidence items belong to the deal. So a shared party, or a
//     missing date, never qualifies a candidate alone, and a candidate with
//     no labeled evidence qualifies for nothing.
// Its score ranks the deals it qualifies for, with the weights in tuning.ts:
//   codenameWeight x name match + partyWeight x share of the deal's parties
//   it names + timeWeight x (both date ranges known and overlapping).
// The qualifying relation is many-to-many; the fragmentation and merge
// diagnostics read it as is. The headline metrics pair candidates and deals
// one-to-one (assign.ts).

import type { KeyDeal } from './answerKey.ts';
import { byCodePoint } from './compare.ts';
import type { ExportCandidate } from './exportData.ts';
import { MATCH_TUNING } from './tuning.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A candidate's labeled evidence: how many of its linked items the key labels, and how many belong to each deal. */
export type Evidence = { labeled: number; byDeal: Record<string, number> };

export type DealMatch = {
  dealId: string;
  score: number;
  codename: boolean;
  /** Share of the deal's parties the candidate names, 0..1. */
  partyOverlap: number;
  /** 'overlap' | 'disjoint' | 'unknown' (a date missing on either side). */
  time: 'overlap' | 'disjoint' | 'unknown';
  /** The candidate's labeled evidence items that belong to this deal. */
  evidenceItems: number;
  /** Their share of its labeled evidence, 0..1. */
  evidenceShare: number;
};

/** "Project Falcon" -> "falcon". */
export function normalizeCodename(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/^\s*project\s+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * The names a deal goes by, normalized: its codename, its name, the codename
 * derived from a "Project <Codename> ..." name, and its aliases. A key with no
 * codename still matches on its name.
 */
export function dealNames(deal: KeyDeal): string[] {
  const names = new Set<string>();
  for (const value of [deal.codename, deal.name, ...deal.aliases]) {
    if (typeof value !== 'string') continue;
    const normalized = normalizeCodename(value);
    if (normalized) names.add(normalized);
  }
  const derived = /^\s*project\s+([\p{L}\p{N}]+)/iu.exec(deal.name.normalize('NFKD').replace(/[̀-ͯ]/g, ''));
  if (derived) names.add(normalizeCodename(derived[1]));
  return [...names].sort(byCodePoint);
}

const COMPANY_SUFFIXES = new Set([
  'inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'llc', 'llp', 'lp', 'ltd', 'limited',
  'plc', 'gmbh', 'ag', 'sa', 'sas', 'bv', 'nv', 'holdings', 'group',
]);

/** "Heliotrope, Inc." -> "heliotrope". */
export function normalizeCompany(value: string): string {
  const words = value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  while (words.length > 1 && COMPANY_SUFFIXES.has(words[words.length - 1])) words.pop();
  return words.join(' ');
}

function domainMatches(candidateDomain: string, dealDomain: string): boolean {
  const a = candidateDomain.toLowerCase();
  const b = dealDomain.toLowerCase();
  return a === b || a.endsWith(`.${b}`);
}

function partyOverlap(candidate: ExportCandidate, deal: KeyDeal): number {
  if (deal.parties.length === 0) return 0;
  const names = new Set(candidate.parties.map((p) => normalizeCompany(p.name)).filter(Boolean));
  const domains = candidate.parties.map((p) => p.domain).filter(Boolean);
  let matched = 0;
  for (const party of deal.parties) {
    const byDomain = party.domains.some((d) => domains.some((cd) => domainMatches(cd, d)));
    const byName = names.has(normalizeCompany(party.name));
    if (byDomain || byName) matched += 1;
  }
  return matched / deal.parties.length;
}

function codenameMatches(candidate: ExportCandidate, deal: KeyDeal): boolean {
  const guesses = [candidate.codenameGuess, candidate.proposedName]
    .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    .map(normalizeCodename)
    .filter(Boolean);
  if (guesses.length === 0) return false;
  const names = dealNames(deal);
  return guesses.some((g) => names.includes(g));
}

function time(value: string | null): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/** Whether the candidate's date range meets the deal's window, widened by the tolerance. */
export function timeRelation(candidate: ExportCandidate, deal: KeyDeal): DealMatch['time'] {
  const first = time(candidate.firstSeenAt);
  const start = time(deal.window.start);
  const end = time(deal.window.end);
  if (first === null || (start === null && end === null)) return 'unknown';
  const last = time(candidate.lastSeenAt) ?? first;
  const tolerance = MATCH_TUNING.windowToleranceDays * DAY_MS;
  // A date-only end covers that whole day.
  const endOfWindow = end === null ? null : end + (deal.window.end?.length === 10 ? DAY_MS - 1 : 0);
  if (endOfWindow !== null && first > endOfWindow + tolerance) return 'disjoint';
  if (start !== null && last < start - tolerance) return 'disjoint';
  return 'overlap';
}

/** The candidate's match to one deal, or null when it does not qualify. */
export function scoreMatch(candidate: ExportCandidate, deal: KeyDeal, evidence: Evidence): DealMatch | null {
  const relation = timeRelation(candidate, deal);
  if (relation === 'disjoint') return null;
  const codename = codenameMatches(candidate, deal);
  const parties = partyOverlap(candidate, deal);
  if (!codename && parties === 0) return null;
  const evidenceItems = evidence.byDeal[deal.id] ?? 0;
  const evidenceShare = evidence.labeled === 0 ? 0 : evidenceItems / evidence.labeled;
  if (evidence.labeled === 0 || evidenceShare < MATCH_TUNING.minEvidenceShare) return null;
  const score =
    MATCH_TUNING.codenameWeight * (codename ? 1 : 0) +
    MATCH_TUNING.partyWeight * parties +
    MATCH_TUNING.timeWeight * (relation === 'overlap' ? 1 : 0);
  return {
    dealId: deal.id,
    score: Math.round(score * 1000) / 1000,
    codename,
    partyOverlap: parties,
    time: relation,
    evidenceItems,
    evidenceShare,
  };
}

/** Every deal the candidate qualifies for, best first: most evidence, then score, then the lower deal id. */
export function qualifyingDeals(candidate: ExportCandidate, deals: KeyDeal[], evidence: Evidence): DealMatch[] {
  return deals
    .map((deal) => scoreMatch(candidate, deal, evidence))
    .filter((m): m is DealMatch => m !== null)
    .sort((a, b) => b.evidenceItems - a.evidenceItems || b.score - a.score || byCodePoint(a.dealId, b.dealId));
}
