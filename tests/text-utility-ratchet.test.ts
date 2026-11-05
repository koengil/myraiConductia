import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * Ratchet over the invisible-text bug family (contrast contract).
 *
 * A bare `text-[var(--text-…)]` intends FONT-SIZE but Tailwind resolves the
 * arbitrary value as a COLOR utility, emitting `color: <length>` — an invalid
 * color that falls back to the inherited ink and, sharing specificity with
 * every other utility, silently beats whatever text color the component set
 * (dark labels on navy primary buttons was the shipped instance).
 *
 * Correct spellings: `text-(length:--text-sm)` (repo canonical) or
 * `text-[length:var(--text-sm)]`.
 *
 * This test is a RATCHET, not a big-bang sweep: the existing debt is frozen
 * in tests/helpers/text-utility-baseline.json and may only shrink. It fails
 * when a file INCREASES its count or a new file introduces the pattern.
 * When you fix occurrences, regenerate the baseline (delete the file's entry
 * or lower its count) so the ratchet tightens.
 */

const BARE_PATTERN = /text-\[var\(--text-/g;
const SRC = join(process.cwd(), 'src');
const BASELINE_PATH = join(process.cwd(), 'tests/helpers/text-utility-baseline.json');

function scan(dir: string, counts: Record<string, number>) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      scan(full, counts);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      const matches = readFileSync(full, 'utf8').match(BARE_PATTERN);
      if (matches) {
        counts[full.slice(process.cwd().length + 1).replaceAll('\\', '/')] = matches.length;
      }
    }
  }
}

describe('text utility ratchet (invisible-text bug family)', () => {
  const current: Record<string, number> = {};
  scan(SRC, current);
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Record<string, number>;

  it('no NEW file introduces the bare text-[var(--text-…)] utility', () => {
    const newcomers = Object.keys(current).filter((f) => !(f in baseline));
    expect(
      newcomers,
      `These files introduce the ambiguous size-as-color utility. ` +
        `Use text-(length:--text-sm) (or text-[length:var(--text-sm)]) instead.`,
    ).toEqual([]);
  });

  it('no file INCREASES its count over the frozen baseline', () => {
    const regressions = Object.entries(current)
      .filter(([file, count]) => file in baseline && count > baseline[file])
      .map(([file, count]) => `${file}: ${baseline[file]} -> ${count}`);
    expect(
      regressions,
      `The ambiguous size-as-color utility grew in these files. ` +
        `Use text-(length:--text-sm) (or text-[length:var(--text-sm)]) instead.`,
    ).toEqual([]);
  });

  it('the baseline never lists files that are already clean (keep the ratchet tight)', () => {
    const stale = Object.keys(baseline).filter((f) => !(f in current));
    expect(
      stale,
      'These baseline entries are already clean — remove them from ' +
        'tests/helpers/text-utility-baseline.json so the debt cannot regrow.',
    ).toEqual([]);
  });
});
