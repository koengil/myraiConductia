// Regenerates src/lib/compliance/lexicon.generated.ts from plain-text exports
// of the two Ignatious lexicon documents (#163).
//
// The .docx files are confidential training material and are NOT in the repo.
// Only the operational data enters the product: the phrase, its tier, and its
// place in the library (category 1..24, family 1..228). The analysis columns
// (what it may indicate, context that raises risk, common legitimate use)
// stay in the parent document. When a new version arrives:
//   textutil -convert txt -output lexicon.txt  <Lexicon .docx>
//   textutil -convert txt -output index.txt    <Phrase Index .docx>
//   node --import tsx scripts/lexicon-extract.ts lexicon.txt index.txt "<version>"
// review the diff, ship.
//
// Input shapes (textutil output):
//   Lexicon, Section 6 "Indicator Library": 24 numbered category headings,
//     each followed by one table — a 5-cell header row ("Phrase family" …
//     "Tier") then rows of family / indicates / context / legitimate / tier,
//     one paragraph per cell, the tier cell being a bare 1, 2 or 3.
//   Phrase Index: a header, then line triplets <index>\n<phrase>\n<tier>
//     after the "Phrase or construction" column header, ending at the Appendix.
// The index is the ORDER and the SPELLING of record (alphabetical, 521); the
// lexicon supplies the structure. Every index phrase must resolve to exactly
// one family, with the same tier — anything else is a data error, not a
// silent default.

import { readFileSync, writeFileSync } from 'node:fs';

const [, , lexiconPath, indexPath, version] = process.argv;
if (!lexiconPath || !indexPath || !version) {
  console.error('Usage: lexicon-extract.ts <lexicon.txt> <phrase-index.txt> <version>');
  process.exit(1);
}

type Tier = 1 | 2 | 3;

function straightQuotes(text: string): string {
  return text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
}
function variantKey(text: string): string {
  return straightQuotes(text).replace(/\s+/g, ' ').trim().replace(/^"|"$/g, '').trim().toLowerCase();
}

// ---- Lexicon: Section 6 → categories + families -------------------------
const lexiconLines = readFileSync(lexiconPath, 'utf8').split('\n');
const sectionStart = lexiconLines.findIndex((l) => l.trim().startsWith('6. Indicator Library'));
if (sectionStart < 0) throw new Error('Section "6. Indicator Library" not found');
const anchors = lexiconLines
  .map((l, i) => (l.trim() === 'Phrase family' ? i : -1))
  .filter((i) => i >= 0);
if (anchors.length !== 24) throw new Error(`Expected 24 "Phrase family" tables, found ${anchors.length}`);
const sectionEnd = lexiconLines.findIndex(
  (l, i) => i > anchors[anchors.length - 1] && /^7\.\s/.test(l.trim()),
);
if (sectionEnd < 0) throw new Error('Section 7 heading (end of the library) not found');

const HEADING = /^(\d{1,2})\.\s+(.+)$/;
const categories: Record<number, string> = {};
type Family = { id: number; category: number; tier: Tier; variants: string[] };
const families: Family[] = [];

const nextHeading = (line: string): RegExpMatchArray | null => {
  const m = line.match(HEADING);
  return m && Number(m[1]) === Object.keys(categories).length + 1 && line.length < 110 ? m : null;
};

let category = 0;
let i = sectionStart + 1;
while (i < sectionEnd) {
  const line = lexiconLines[i].trim();
  const heading = nextHeading(line);
  if (heading) {
    category = Number(heading[1]);
    categories[category] = heading[2].trim();
    i += 1;
    continue;
  }
  if (line === 'Phrase family') {
    i += 5; // the header row
    let cells: string[] = [];
    while (i < sectionEnd) {
      const cell = lexiconLines[i].trim();
      if (nextHeading(cell)) break;
      if (cell === '') {
        i += 1;
        continue;
      }
      if (/^[123]$/.test(cell) && cells.length > 0) {
        families.push({
          id: families.length + 1,
          category,
          tier: Number(cell) as Tier,
          variants: cells[0].split(/;\s*/).map(variantKey).filter(Boolean),
        });
        cells = [];
        i += 1;
        continue;
      }
      cells.push(cell);
      i += 1;
    }
    continue;
  }
  i += 1;
}
if (Object.keys(categories).length !== 24) {
  throw new Error(`Expected 24 categories, parsed ${Object.keys(categories).length}`);
}
if (families.length !== 228) throw new Error(`Expected 228 families, parsed ${families.length}`);

// A phrase can sit in more than one family; the index shows the highest
// severity. Resolve to the family whose tier matches the index tier — and
// refuse a tie (two same-tier families claiming one phrase): that is a data
// error to surface, never a silent first-wins default.
const familiesByVariant = new Map<string, Family[]>();
for (const f of families) {
  for (const v of f.variants) {
    const list = familiesByVariant.get(v) ?? [];
    list.push(f);
    familiesByVariant.set(v, list);
  }
}

// ---- Phrase Index: order and spelling of record ---------------------------
const indexLines = readFileSync(indexPath, 'utf8').split('\n');
const headerAt = indexLines.findIndex((l) => l.trim() === 'Phrase or construction');
if (headerAt < 0) throw new Error('Column header "Phrase or construction" not found');
const start = headerAt + 2; // skip the "Tier" header line
const end = indexLines.findIndex((l, idx) => idx > start && l.trim().startsWith('Appendix'));
const body = indexLines.slice(start, end < 0 ? undefined : end).filter((l) => l.trim() !== '');
if (body.length % 3 !== 0) {
  throw new Error(`Expected index/phrase/tier triplets, got ${body.length} lines`);
}

type Entry = { phrase: string; tier: Tier; category: number; family: number };
const entries: Entry[] = [];
for (let k = 0; k < body.length; k += 3) {
  const index = Number(body[k].trim());
  const phrase = straightQuotes(body[k + 1].trim());
  const tier = Number(body[k + 2].trim());
  if (!Number.isInteger(index) || !phrase || ![1, 2, 3].includes(tier)) {
    throw new Error(`Malformed triplet at input line ${start + k + 1}: ${body.slice(k, k + 3).join(' | ')}`);
  }
  const candidates = familiesByVariant.get(variantKey(phrase)) ?? [];
  const sameTier = candidates.filter((f) => f.tier === tier);
  if (sameTier.length > 1) {
    throw new Error(
      `Index phrase "${phrase}" (tier ${tier}) is claimed by ${sameTier.length} families at that tier: ${sameTier.map((f) => `${f.id} (category ${f.category})`).join(', ')}`,
    );
  }
  const family = sameTier[0];
  if (!family) {
    throw new Error(
      `Index phrase "${phrase}" (tier ${tier}) has no family with that tier in the lexicon` +
        (candidates.length ? ` (families ${candidates.map((f) => `${f.id}@T${f.tier}`).join(', ')})` : ''),
    );
  }
  entries.push({ phrase, tier: tier as Tier, category: family.category, family: family.id });
}

const counts = [1, 2, 3].map((t) => entries.filter((e) => e.tier === t).length);
const coveredFamilies = new Set(entries.map((e) => e.family));
if (coveredFamilies.size !== families.length) {
  throw new Error(`Only ${coveredFamilies.size} of ${families.length} families are reached by an index phrase`);
}
console.log(
  `Parsed ${entries.length} phrases (T1 ${counts[0]} / T2 ${counts[1]} / T3 ${counts[2]}) across ${families.length} families in ${Object.keys(categories).length} categories`,
);

const out = `// GENERATED by scripts/lexicon-extract.ts — do not edit by hand.
// Source: Ignatious Cumulative Phrase Index, version ${version}
// (companion to the Communications Risk Lexicon and Pre-Send Operating
// Standard, whose Section 6 supplies the category and family structure).
// The parent documents are confidential and stay OUT of the repo; this is
// the operational phrase list plus its place in the library only — never
// the analysis columns. Regenerate on version bumps.
//
// ${entries.length} phrases: Tier 1 ${counts[0]} · Tier 2 ${counts[1]} · Tier 3 ${counts[2]} ·
// ${families.length} families · ${Object.keys(categories).length} categories.
// A tier is a CEILING, not an assessment — see src/lib/compliance/lexicon.ts.

export type LexiconTier = 1 | 2 | 3;

export type LexiconEntry = {
  phrase: string;
  tier: LexiconTier;
  /** Library category, 1..24 (see LEXICON_CATEGORIES). */
  category: number;
  /** Phrase family within the library, 1..228 (library order). */
  family: number;
};

export const LEXICON_VERSION = ${JSON.stringify(version)};

/** The 24 category names, by number, from the lexicon's indicator library. */
export const LEXICON_CATEGORIES: Readonly<Record<number, string>> = {
${Object.entries(categories)
  .map(([n, name]) => `  ${n}: ${JSON.stringify(name)},`)
  .join('\n')}
};

export const LEXICON_ENTRIES: readonly LexiconEntry[] = [
${entries
  .map((e) => `  { phrase: ${JSON.stringify(e.phrase)}, tier: ${e.tier}, category: ${e.category}, family: ${e.family} },`)
  .join('\n')}
];
`;

writeFileSync(new URL('../src/lib/compliance/lexicon.generated.ts', import.meta.url), out);
console.log('Wrote src/lib/compliance/lexicon.generated.ts');
