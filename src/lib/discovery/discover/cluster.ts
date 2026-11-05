// Clustering (phase 3): firm-routed items become candidate groups by codename,
// split where the mail goes quiet for longer than a deal's gap, with the
// external parties that appear on them.
//
// A group's clusterKey is the worker's stable identity for the candidate, so
// re-running over the same mail updates one candidate instead of adding a
// second: `codename:<key>` for the first window of a codename, then `#2`,
// `#3` for later windows in date order.

import type { Participant } from '@/lib/discovery/normalize';
import type { RouteMethod } from '@/lib/constants/discovery';
import type { RoutedItem } from '@/lib/discovery/route/firmRules';

/** A codename reused after this long without mail is treated as a new deal. */
export const WINDOW_GAP_DAYS = 540;

export type CandidateParty = { name: string; domain: string };

export type CandidateLink = {
  internetMessageId: string;
  method: RouteMethod;
  confidence: number;
};

export type CandidateGroup = {
  clusterKey: string;
  proposedName: string;
  codenameGuess: string;
  parties: CandidateParty[];
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  confidence: number;
  links: CandidateLink[];
};

const DAY_MS = 24 * 60 * 60 * 1000;

function domainOf(address: string): string | null {
  const at = address.lastIndexOf('@');
  return at > 0 ? address.slice(at + 1).toLowerCase() : null;
}

/** "cobalt-systems.example" -> "Cobalt Systems". A guess for display; the domain is the key. */
export function partyNameFromDomain(domain: string): string {
  const label = domain.split('.')[0] ?? domain;
  return label
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/**
 * External parties: participant domains outside the firm, most frequent
 * first, then by domain.
 */
function partiesOf(entries: RoutedItem[], internalDomains: ReadonlySet<string>): CandidateParty[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const domains = new Set(
      entry.item.participants
        .map((p: Participant) => domainOf(p.address))
        .filter((d): d is string => d !== null && !internalDomains.has(d)),
    );
    for (const domain of domains) counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([domain]) => ({ name: partyNameFromDomain(domain), domain }));
}

function timeOf(entry: RoutedItem): number {
  const value = entry.item.sentAt ? Date.parse(entry.item.sentAt) : NaN;
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

/** Splits a codename's items into windows separated by more than WINDOW_GAP_DAYS. */
function windows(entries: RoutedItem[]): RoutedItem[][] {
  const sorted = [...entries].sort(
    (a, b) => timeOf(a) - timeOf(b) || a.item.internetMessageId.localeCompare(b.item.internetMessageId),
  );
  const result: RoutedItem[][] = [];
  let current: RoutedItem[] = [];
  let last = Number.NEGATIVE_INFINITY;
  for (const entry of sorted) {
    const t = timeOf(entry);
    if (current.length > 0 && Number.isFinite(t) && Number.isFinite(last) && t - last > WINDOW_GAP_DAYS * DAY_MS) {
      result.push(current);
      current = [];
    }
    current.push(entry);
    if (Number.isFinite(t)) last = t;
  }
  if (current.length > 0) result.push(current);
  return result;
}

export function clusterCandidates(
  routed: RoutedItem[],
  options: { internalDomains: Iterable<string> },
): CandidateGroup[] {
  const internalDomains = new Set([...options.internalDomains].map((d) => d.toLowerCase()));
  const byCodename = new Map<string, { codename: string; entries: RoutedItem[] }>();
  for (const entry of routed) {
    for (const route of entry.routes) {
      const bucket = byCodename.get(route.codenameKey) ?? { codename: route.codename, entries: [] };
      if (!bucket.entries.includes(entry)) bucket.entries.push(entry);
      byCodename.set(route.codenameKey, bucket);
    }
  }

  const groups: CandidateGroup[] = [];
  for (const [key, { codename, entries }] of [...byCodename].sort((a, b) => a[0].localeCompare(b[0]))) {
    windows(entries).forEach((windowEntries, index) => {
      const links: CandidateLink[] = windowEntries.map((entry) => {
        const route = entry.routes.find((r) => r.codenameKey === key)!;
        return {
          internetMessageId: entry.item.internetMessageId,
          method: route.method,
          confidence: route.confidence,
        };
      });
      const times = windowEntries.map(timeOf).filter(Number.isFinite);
      groups.push({
        clusterKey: index === 0 ? `codename:${key}` : `codename:${key}#${index + 1}`,
        proposedName: codename,
        codenameGuess: codename,
        parties: partiesOf(windowEntries, internalDomains),
        firstSeenAt: times.length ? new Date(Math.min(...times)).toISOString() : null,
        lastSeenAt: times.length ? new Date(Math.max(...times)).toISOString() : null,
        confidence: Math.max(...links.map((l) => l.confidence)),
        links,
      });
    });
  }
  return groups;
}
