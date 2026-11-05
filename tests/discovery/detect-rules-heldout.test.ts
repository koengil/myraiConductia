// @vitest-environment node
// The held-out hook for the rule detector (#173 G-07, design R7). The orchestrator commissions the set from an
// agent that never sees the rule text, as JSON lines under tests/fixtures/discovery/detect/heldout/*.jsonl:
//   {"sentence": "<one sentence>", "sentAt": "2026-09-18T10:00:00Z", "expected": "<MilestoneType>" | null}
// The measurement skips while that directory is missing or holds no .jsonl file. It prints one line of counts
// and never a sentence; a loader error names the file and line only.
//
// Scoring, per sentence: expected T and an event of type T is a true positive, no event of type T a false
// negative; any event of another type is also a false positive. Expected null and no event is a true negative,
// any event a false positive.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { detectMilestones } from '@/lib/discovery/detect';
import { MILESTONE_TYPES, type MilestoneType } from '@/lib/discovery/milestones';

const HELDOUT_DIR = join(process.cwd(), 'tests/fixtures/discovery/detect/heldout');
/** rules/v1 on the orchestrator's three files (343 sentences), measured 2026-10-22 after the audit round. */
const HELDOUT_FLOOR = { tp: 18, fp: 1 };

type HeldoutCase = { sentence: string; sentAt: string; expected: MilestoneType | null };
type Counts = { tp: number; fp: number; fn: number; tn: number };

const isMilestoneType = (value: unknown): value is MilestoneType =>
  typeof value === 'string' && (MILESTONE_TYPES as readonly string[]).includes(value);

/** One held-out file. Blank lines are skipped; anything else must be a well-formed case. */
function parseHeldout(name: string, text: string): HeldoutCase[] {
  const cases: HeldoutCase[] = [];
  text.split('\n').forEach((raw, i) => {
    if (raw.trim() === '') return;
    const where = `${name}:${i + 1}`;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error(`${where}: not a JSON object`);
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${where}: not a JSON object`);
    const row = value as Record<string, unknown>;
    const { sentence, sentAt, expected } = row;
    if (typeof sentence !== 'string' || sentence.trim() === '') throw new Error(`${where}: sentence must be a non-empty string`);
    if (typeof sentAt !== 'string' || !Number.isFinite(Date.parse(sentAt))) throw new Error(`${where}: sentAt must be an ISO timestamp`);
    if (!('expected' in row)) throw new Error(`${where}: expected is missing`);
    if (expected !== null && !isMilestoneType(expected)) throw new Error(`${where}: expected must be a milestone type or null`);
    cases.push({ sentence, sentAt, expected: expected as MilestoneType | null });
  });
  return cases;
}

function score(cases: readonly HeldoutCase[]): Counts {
  const counts: Counts = { tp: 0, fp: 0, fn: 0, tn: 0 };
  for (const c of cases) {
    const types = new Set(detectMilestones(c.sentence, c.sentAt).map((e) => e.type));
    if (c.expected === null) {
      if (types.size > 0) counts.fp += 1;
      else counts.tn += 1;
      continue;
    }
    if (types.has(c.expected)) counts.tp += 1;
    else counts.fn += 1;
    if (Array.from(types).some((t) => t !== c.expected)) counts.fp += 1;
  }
  return counts;
}

const heldoutFiles = existsSync(HELDOUT_DIR) ? readdirSync(HELDOUT_DIR).filter((n) => n.endsWith('.jsonl')).sort() : [];

describe('the held-out loader', () => {
  it('reads cases with a type or null, and skips blank lines', () => {
    const text = [
      '{"sentence": "The LOI was signed on 18 September 2026.", "sentAt": "2026-09-18T10:00:00Z", "expected": "loi_signed"}',
      '',
      '{"sentence": "Lunch is at noon.", "sentAt": "2026-09-18T10:00:00Z", "expected": null}',
    ].join('\n');
    expect(parseHeldout('a.jsonl', text)).toEqual([
      { sentence: 'The LOI was signed on 18 September 2026.', sentAt: '2026-09-18T10:00:00Z', expected: 'loi_signed' },
      { sentence: 'Lunch is at noon.', sentAt: '2026-09-18T10:00:00Z', expected: null },
    ]);
  });

  it.each([
    ['a malformed line', '{"sentence": "Secret words', 'b.jsonl:2: not a JSON object'],
    ['a JSON array', '["Secret words"]', 'b.jsonl:2: not a JSON object'],
    ['an unknown type', '{"sentence": "Secret words", "sentAt": "2026-09-18T10:00:00Z", "expected": "deal_won"}', 'b.jsonl:2: expected must be a milestone type or null'],
    ['a missing expected', '{"sentence": "Secret words", "sentAt": "2026-09-18T10:00:00Z"}', 'b.jsonl:2: expected is missing'],
    ['an empty sentence', '{"sentence": " ", "sentAt": "2026-09-18T10:00:00Z", "expected": null}', 'b.jsonl:2: sentence must be a non-empty string'],
    ['a bad sentAt', '{"sentence": "Secret words", "sentAt": "soon", "expected": null}', 'b.jsonl:2: sentAt must be an ISO timestamp'],
  ])('fails on %s, naming the file and line but not the sentence', (_label, line, message) => {
    const good = '{"sentence": "Lunch is at noon.", "sentAt": "2026-09-18T10:00:00Z", "expected": null}';
    expect(() => parseHeldout('b.jsonl', `${good}\n${line}`)).toThrow(new Error(message));
  });

  it('scores true and false positives and negatives', () => {
    const at = '2026-09-20T09:00:00Z';
    expect(
      score([
        { sentence: 'The LOI was signed on 18 September 2026.', sentAt: at, expected: 'loi_signed' },
        { sentence: 'The SPA was signed on 28 October 2026.', sentAt: at, expected: 'loi_signed' },
        { sentence: 'The LOI was not signed.', sentAt: at, expected: null },
        { sentence: 'The data room opened on 28 May 2026.', sentAt: at, expected: null },
        { sentence: 'Project Osprey closed on 15 July 2025.', sentAt: at, expected: 'closed' },
      ]),
    ).toEqual({ tp: 1, fp: 2, fn: 2, tn: 1 });
  });
});

describe('the held-out set (orchestrator-commissioned)', () => {
  it.skipIf(heldoutFiles.length === 0)('measures precision and recall, printing counts only', () => {
    const cases = heldoutFiles.flatMap((name) => parseHeldout(name, readFileSync(join(HELDOUT_DIR, name), 'utf8')));
    expect(cases.length).toBeGreaterThan(0);
    const { tp, fp, fn, tn } = score(cases);
    console.log(`heldout files=${heldoutFiles.length} sentences=${cases.length} tp=${tp} fp=${fp} fn=${fn} tn=${tn}`);
    // The floor measured after the audit round (#173 G-07 audit S13): a change to the rules may find more and
    // misfire less, never the other way. Counts only, never a sentence.
    expect(tp, 'held-out true positives').toBeGreaterThanOrEqual(HELDOUT_FLOOR.tp);
    expect(fp, 'held-out false positives').toBeLessThanOrEqual(HELDOUT_FLOOR.fp);
  });
});
