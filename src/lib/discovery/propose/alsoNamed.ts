// Demo-only (#460, #623): the other names a known deal's own mail uses, for the
// proposal prompt. Delete this folder when #459 lands.
//
// Bankers write about a deal by its client, target or bidder as often as by its
// codename ("Kestrel: Ashgrove valuation"). The prompt lists those names next to
// each known deal, so the model attaches "Deal team change: Ashgrove" to Kestrel
// instead of naming a new deal. Only subjects are read: they carry company names
// and never a signature. The tally is kept per mailbox (the step holds one per
// content source), so one banker's mail never names another banker's deals, and
// it lives in memory for the run: nothing is stored.

import { codenamesIn, type RoutedItem } from '@/lib/discovery/route/firmRules';

const WORD = /\b[A-Z][a-z]{3,}\b/g;

/** The grouping key a known deal's name stands for: "Project Halyard" is "halyard", a bare "Kestrel" is "kestrel". */
export function dealKeyOfName(name: string): string {
  return codenamesIn(name)[0]?.key ?? name.trim().toLowerCase();
}

export class SubjectNames {
  private readonly byKey = new Map<string, Map<string, number>>();

  /** Counts the capitalized words in the subjects of the routed entries, under each deal they route to. */
  add(entries: readonly RoutedItem[]): void {
    for (const entry of entries) {
      if (entry.routes.length === 0) continue;
      const words = new Set(entry.item.subject.match(WORD) ?? []);
      for (const key of new Set(entry.routes.map((r) => r.codenameKey))) {
        const counts = this.byKey.get(key) ?? new Map<string, number>();
        for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
        this.byKey.set(key, counts);
      }
    }
  }

  /** Words in this deal's subjects and in no other deal's, most used first; never a word of its own name. */
  for(name: string): string[] {
    const key = dealKeyOfName(name);
    const own = this.byKey.get(key);
    if (!own) return [];
    const elsewhere = new Set([...this.byKey].filter(([k]) => k !== key).flatMap(([, counts]) => [...counts.keys()]));
    const nameWords = new Set(name.toLowerCase().split(/\s+/));
    return [...own]
      .filter(([word]) => !elsewhere.has(word) && !nameWords.has(word.toLowerCase()) && word.toLowerCase() !== key)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([word]) => word);
  }
}
