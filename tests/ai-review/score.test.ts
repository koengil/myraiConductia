import { describe, expect, it } from 'vitest';

import { aggregate, isAiReviewer, latestPerPr, median, parseArtifactName, renderTable, type RunResult, type Thread } from '../../scripts/ai-review/score';

const result = (over: Partial<RunResult> = {}): RunResult => ({
  lenses: [
    { lens: 'generalist', status: 'ok', durationMs: 10000, findings: 3 },
    { lens: 'governance', status: 'failed', durationMs: 4000, findings: 0 },
  ],
  counts: { raw: 3, confirmed: 2, rejected: 1, unclear: 0, noVerdict: 0, final: 2 },
  rejected: [{ lens: 'generalist', file: 'src/c.ts', line: 9 }],
  findings: [
    { lens: 'generalist', file: 'src/a.ts', line: 10 },
    { lens: 'generalist', file: 'src/b.ts', line: 20 },
  ],
  ...over,
});

const thread = (over: Partial<Thread>): Thread => ({ isResolved: false, isOutdated: false, bot: true, path: 'src/a.ts', line: 10, originalLine: 10, ...over });

describe('score', () => {
  it('parses artifact names', () => {
    expect(parseArtifactName('ai-review-513-abcdef1234')).toBe(513);
    expect(parseArtifactName('coverage-513-abcdef1234')).toBeNull();
    expect(parseArtifactName('ai-review-x-abc')).toBeNull();
  });

  it('computes medians', () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it('aggregates per lens and matches threads', () => {
    const threads = new Map([
      [
        7,
        [
          thread({ isResolved: true }),
          thread({ path: 'src/b.ts', line: null, originalLine: 20, isOutdated: true }),
          thread({ bot: false, path: 'src/a.ts', line: 12 }),
          thread({ bot: false, path: 'src/z.ts', line: 1, originalLine: 1 }),
        ],
      ],
    ]);
    const s = aggregate([{ pr: 7, result: result() }], threads);
    expect(s.rows.generalist).toMatchObject({ runs: 1, raw: 3, rejected: 1, posted: 2, threaded: 2, acted: 2, failed: 0 });
    expect(s.rows.governance).toMatchObject({ runs: 1, failed: 1 });
    expect(s.rows['tests-agentic'].runs).toBe(0);
    expect(s.totals.confirmed).toBe(2);
    expect(s.humanComments).toBe(2);
    expect(s.misses).toBe(1);
  });

  it('keeps judge roles out of lens rows and reports them separately', () => {
    const judged = result({
      lenses: [
        { role: 'lens', lens: 'generalist', status: 'ok', durationMs: 10000, findings: 3 },
        { role: 'validator', status: 'failed', durationMs: 2000, findings: 0 },
        { role: 'validator', status: 'ok', durationMs: 4000, findings: 0 },
        { role: 'evaluator', status: 'ok', durationMs: 6000, findings: 0 },
      ],
    });
    const s = aggregate([{ pr: 7, result: judged }], new Map());
    expect(s.rows.generalist).toMatchObject({ runs: 1, raw: 3, failed: 0, durations: [10000] });
    expect(s.rows.validator).toMatchObject({ runs: 2, failed: 1, raw: 0, durations: [2000, 4000] });
    expect(s.rows.evaluator).toMatchObject({ runs: 1, failed: 0, durations: [6000] });
    const table = renderTable(s, 7, 1);
    expect(table).toContain('| validator | 2 | 1 | - | - | - | - | - | 3 |');
    expect(table).toContain('| evaluator | 1 | 0 | - | - | - | - | - | 6 |');
  });

  it('counts an entry with no role as a lens run', () => {
    const legacy = result({ lenses: [{ lens: 'generalist', status: 'ok', durationMs: 8000, findings: 1 }] });
    const s = aggregate([{ pr: 7, result: legacy }], new Map());
    expect(s.rows.generalist).toMatchObject({ runs: 1, raw: 1 });
    expect(s.rows.validator.runs).toBe(0);
  });

  it('counts an unresolved, unchanged thread as not acted on', () => {
    const s = aggregate([{ pr: 7, result: result() }], new Map([[7, [thread({})]]]));
    expect(s.rows.generalist).toMatchObject({ posted: 2, threaded: 1, acted: 0 });
  });

  it('keeps only the newest artifact per PR', () => {
    const a = (name: string, created_at: string) => ({ name, created_at });
    const kept = latestPerPr([
      a('ai-review-7-aaaaaaa', '2026-10-10T10:00:00Z'),
      a('ai-review-7-bbbbbbb', '2026-10-12T10:00:00Z'),
      a('ai-review-7-ccccccc', '2026-10-11T10:00:00Z'),
      a('ai-review-8-ddddddd', '2026-10-01T10:00:00Z'),
      a('coverage-7-eeeeeee', '2026-10-13T10:00:00Z'),
    ]);
    expect(kept.map((x) => x.name).sort()).toEqual(['ai-review-7-bbbbbbb', 'ai-review-8-ddddddd']);
  });

  it('recognises only the github-actions identities as the AI reviewer', () => {
    expect(isAiReviewer('github-actions')).toBe(true);
    expect(isAiReviewer('github-actions[bot]')).toBe(true);
    expect(isAiReviewer('some-human')).toBe(false);
    expect(isAiReviewer('dependabot[bot]')).toBe(false);
    expect(isAiReviewer('')).toBe(false);
    expect(isAiReviewer(undefined)).toBe(false);
  });

  it('renders a table with n/a for empty denominators', () => {
    const out = renderTable(aggregate([], new Map()), 7, 0);
    expect(out).toContain('| generalist | 0 | 0 | 0 | 0 | 0 | 0 | n/a | n/a |');
  });
});

describe('withheld runs', () => {
  it('counts a withheld artifact without reading its missing fields', () => {
    const withheld = { withheld: true, counts: { raw: 2, confirmed: 1, rejected: 1, final: 1 } } as unknown as RunResult;
    const s = aggregate([{ pr: 9, result: withheld }], new Map());
    expect(s.withheld).toBe(1);
    expect(s.rows.generalist.runs).toBe(0);
  });
});
