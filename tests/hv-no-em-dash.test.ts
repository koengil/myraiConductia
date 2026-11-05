import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The em dash rule of scripts/hv/ledger_to_rail.py (`no_em_dash`), ported so
 * its cases run in vitest. A test below reads the script and checks the one
 * word list the two share, and that the committed catalog has no dash left.
 */
const D = '—';
const COMMA_AFTER_ASIDE = new Set(['anticipates', 'then', 'turning', 'generates', 'monitoring', 'each']);

function noEmDash(v: string): string {
  if (!v.includes(D)) return v;
  const parts = v.split(new RegExp(` *${D} *`));
  let out = parts[0];
  let k = 1;
  while (k < parts.length) {
    if (k + 1 < parts.length && !/[.?!;\n]/.test(parts[k])) {
      const next = parts[k + 1];
      const first = next.match(/^[A-Za-z]+/)?.[0] ?? '';
      const glue = /^[,.;:)]/.test(next) ? '' : COMMA_AFTER_ASIDE.has(first) ? ', ' : ' ';
      out += ` (${parts[k]})${glue}${next}`;
      k += 2;
      continue;
    }
    const clause = out.split(/[.?!]\s|\n/).pop() ?? '';
    out += /[.:?!]\s*$/.test(out) ? ` ${parts[k]}` : `${clause.includes(':') ? ', ' : ': '}${parts[k]}`;
    k += 1;
  }
  return out;
}

describe('no_em_dash (scripts/hv/ledger_to_rail.py)', () => {
  it('turns one dash into a colon', () => {
    expect(noEmDash(`MD ${D} relationship, pursue/pass`)).toBe('MD: relationship, pursue/pass');
  });

  it('turns one dash into a comma when the clause already has a colon', () => {
    expect(noEmDash(`Drafts: A list ${D} then a note`)).toBe('Drafts: A list, then a note');
  });

  it('wraps a pair inside one sentence on one line in parentheses', () => {
    expect(noEmDash(`Scores propensity ${D} which companies sell soon ${D} from funding history.`)).toBe(
      'Scores propensity (which companies sell soon) from funding history.',
    );
  });

  it('puts a comma after the aside when the next word is a verb that needs one', () => {
    expect(noEmDash(`the best approach ${D} CEO narrative, CFO case ${D} anticipates objections`)).toBe(
      'the best approach (CEO narrative, CFO case), anticipates objections',
    );
  });

  it('treats a pair that spans a sentence boundary as two single dashes', () => {
    expect(noEmDash(`Engagement ${D} first. Second part ${D} third`)).toBe('Engagement: first. Second part: third');
  });

  it('treats a pair that spans lines as two single dashes', () => {
    expect(noEmDash(`Engagement screen ${D} [Target]\nResult: CLEAR ${D} sign-off`)).toBe(
      'Engagement screen: [Target]\nResult: CLEAR, sign-off',
    );
    expect(noEmDash(`To: [Founder ${D} filings]\nSubject: Intro ${D} options`)).toBe(
      'To: [Founder, filings]\nSubject: Intro, options',
    );
  });

  it('pairs the first two of three dashes and gives the last its own colon', () => {
    expect(noEmDash(`A banker ${D} with the finance team ${D} owns the numbers, which is what a buyer sees ${D} which is why`)).toBe(
      'A banker (with the finance team) owns the numbers, which is what a buyer sees: which is why',
    );
  });

  it('leaves text without a dash alone', () => {
    expect(noEmDash('Plain sentence.')).toBe('Plain sentence.');
  });
});

describe('the generator and the committed catalog', () => {
  const script = readFileSync('scripts/hv/ledger_to_rail.py', 'utf8');

  it('share the comma-after-aside word list', () => {
    const listed = script.match(/COMMA_AFTER_ASIDE = \{([^}]*)\}/)?.[1].match(/"[a-z]+"/g)?.map((w) => w.slice(1, -1)) ?? [];
    expect(new Set(listed)).toEqual(COMMA_AFTER_ASIDE);
  });

  it('left no em dash in a catalog string', () => {
    const data = readFileSync('src/lib/rail/railData.generated.ts', 'utf8').split('\n').filter((l) => !l.startsWith('//'));
    expect(data.filter((l) => l.includes(D))).toEqual([]);
  });
});
