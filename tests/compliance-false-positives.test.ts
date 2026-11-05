import { describe, expect, it } from 'vitest';

import { evaluateRules, outcomeFor, summarize } from '@/lib/compliance/screeningEval';
import { CORE_CORPUS, SCREENING_CORPUS } from './fixtures/compliance/screeningCorpus';

/**
 * The rule layer's current disagreements with the corpus, measured on
 * 2026-09-29 (7 of 30) and tuned on 2026-09-30 (2 of 30). These pin today's
 * behaviour: tuning the rules should shrink RULE_FALSE_POSITIVES, and this
 * test then needs updating on purpose. The
 * misses are cases only the AI layer can judge (performance claims, a
 * tip without a trigger word), so they are expected at this layer.
 */
const RULE_FALSE_POSITIVES = [
  'figures-04', // a public 10-K figure next to "margin"; the rules cannot tell the source
  'commit-03', // "we guarantee" confidentiality: left flagged, a reviewer could read it as overpromising
];
const RULE_MISSES = ['promise-04', 'mnpi-04'];

describe('screening corpus', () => {
  it('has unique ids and both kinds of case', () => {
    const ids = SCREENING_CORPUS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(SCREENING_CORPUS.some((c) => c.expected === 'clear')).toBe(true);
    expect(SCREENING_CORPUS.some((c) => c.expected === 'flag')).toBe(true);
  });
});

describe('outcomeFor', () => {
  it('names each combination of expectation and result', () => {
    expect(outcomeFor('clear', false)).toBe('ok');
    expect(outcomeFor('clear', true)).toBe('false-positive');
    expect(outcomeFor('flag', true)).toBe('caught');
    expect(outcomeFor('flag', false)).toBe('missed');
  });
});

describe('summarize', () => {
  it('computes the false-positive rate over clear cases only', () => {
    const summary = summarize([
      { id: 'a', kind: 'logistics', expected: 'clear', flagged: false, outcome: 'ok', reasons: [] },
      { id: 'b', kind: 'idiom', expected: 'clear', flagged: true, outcome: 'false-positive', reasons: ['x'] },
      { id: 'c', kind: 'mnpi', expected: 'flag', flagged: true, outcome: 'caught', reasons: ['y'] },
      { id: 'd', kind: 'mnpi', expected: 'flag', flagged: false, outcome: 'missed', reasons: [] },
    ]);
    expect(summary).toEqual({
      clear: 2,
      falsePositives: 1,
      falsePositiveRate: 0.5,
      flag: 2,
      caught: 1,
      missed: 1,
    });
  });

  it('reports a zero rate when there are no clear cases', () => {
    expect(summarize([]).falsePositiveRate).toBe(0);
  });
});

describe('rule layer against the core corpus', () => {
  const results = evaluateRules(CORE_CORPUS);

  it('measures the baseline over 30 ordinary and 15 risky emails', () => {
    // Pinned with the ids below, so removing or relabelling a case that the
    // rules handle correctly also changes the reported baseline on purpose.
    const summary = summarize(results);
    expect(summary.clear).toBe(30);
    expect(summary.flag).toBe(15);
    expect(summary.falsePositives).toBe(RULE_FALSE_POSITIVES.length);
    expect(summary.caught).toBe(15 - RULE_MISSES.length);
  });

  it('flags exactly the known false positives among clear cases', () => {
    const fps = results.filter((r) => r.outcome === 'false-positive').map((r) => r.id);
    expect(fps.sort()).toEqual([...RULE_FALSE_POSITIVES].sort());
  });

  it('misses only the cases that need the AI layer', () => {
    const missed = results.filter((r) => r.outcome === 'missed').map((r) => r.id);
    expect(missed.sort()).toEqual([...RULE_MISSES].sort());
  });

  it('catches a leak split across subject and body', () => {
    // "Project Birch valuation" in the subject, the figure in the body.
    expect(results.find((r) => r.id === 'mnpi-01')?.outcome).toBe('caught');
  });

  it('explains every flag', () => {
    for (const r of results.filter((x) => x.flagged)) {
      expect(r.reasons.length).toBeGreaterThan(0);
    }
  });
});

/**
 * The 315 cases added on 2026-10-08 for the Jev measurement (D82), pinned by
 * count. The realistic mix and the near-miss set are reported apart: the
 * near-miss set is hard by design, so blending it would overstate the rate a
 * banker meets. A rule change that moves these numbers updates them on purpose.
 */
describe('rule layer against the whole corpus', () => {
  const results = evaluateRules(SCREENING_CORPUS);
  const realistic = summarize(results.filter((r) => r.kind !== 'near-miss' && r.kind !== 'risk-repository'));
  const nearMiss = summarize(results.filter((r) => r.kind === 'near-miss'));

  it('has unique ids across every case file', () => {
    const ids = SCREENING_CORPUS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(560);
  });

  it('measures the realistic mix: 180 ordinary and 60 risky emails', () => {
    expect(realistic).toMatchObject({ clear: 180, falsePositives: 8, flag: 60, caught: 43, missed: 17 });
  });

  it('measures the near-miss set: 120 ordinary emails that use trigger words innocently', () => {
    expect(nearMiss).toMatchObject({ clear: 120, falsePositives: 89, flag: 0 });
  });
});

/**
 * The risk repository's first slice, added on 2026-10-20 (Storm, Oct 19 build
 * sync): 100 twin pairs, each a risky email and a clean twin in the same words,
 * tagged by risk category and difficulty. Reported apart from the realistic mix
 * and the near-miss set. The rule layer only knows promissory and MNPI wording,
 * and measured on 2026-10-20 it neither catches nor falsely flags any of these:
 * the gap is the finding, pinned so a new rule moves it on purpose.
 */
describe('risk repository', () => {
  const repo = SCREENING_CORPUS.filter((c) => c.kind === 'risk-repository');

  it('keeps the explicit pair ids: repo-001 to repo-100, unique, f then c', () => {
    // The ids are written in the data so a recorded result keeps naming the
    // same case; these are the ids the slice shipped with on 2026-10-20.
    const ids = repo.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe('repo-001f');
    expect(ids[1]).toBe('repo-001c');
    expect(ids.at(-1)).toBe('repo-100c');
    const expected = Array.from({ length: 100 }, (_, i) => String(i + 1).padStart(3, '0')).flatMap((n) => [
      `repo-${n}f`,
      `repo-${n}c`,
    ]);
    expect(ids).toEqual(expected);
  });

  it('pairs every risky email with a clean twin: 100 of each', () => {
    expect(repo).toHaveLength(200);
    expect(repo.filter((c) => c.expected === 'flag')).toHaveLength(100);
    for (const c of repo.filter((x) => x.expected === 'flag')) {
      const twin = repo.find((x) => x.id === c.id.replace(/f$/, 'c'));
      expect(twin?.expected).toBe('clear');
      expect(twin?.risk).toBe(c.risk);
    }
  });

  it('tags every case with a risk category and a difficulty, weighted toward edge cases', () => {
    for (const c of repo) {
      expect(['legal', 'regulatory', 'compliance', 'reputational']).toContain(c.risk);
      expect(['obvious', 'edge']).toContain(c.difficulty);
    }
    const pairsPerRisk = (risk: string) => repo.filter((c) => c.risk === risk && c.expected === 'flag').length;
    expect(pairsPerRisk('legal')).toBe(32);
    expect(pairsPerRisk('regulatory')).toBe(33);
    expect(pairsPerRisk('compliance')).toBe(20);
    expect(pairsPerRisk('reputational')).toBe(15);
    expect(repo.filter((c) => c.difficulty === 'edge').length / repo.length).toBeGreaterThanOrEqual(0.6);
  });

  it('leaves risk and difficulty off every other case', () => {
    for (const c of SCREENING_CORPUS.filter((x) => x.kind !== 'risk-repository')) {
      expect(c.risk).toBeUndefined();
      expect(c.difficulty).toBeUndefined();
    }
  });

  it('measures the rule layer: no catches and no false positives', () => {
    expect(summarize(evaluateRules(repo))).toMatchObject({ clear: 100, falsePositives: 0, flag: 100, caught: 0, missed: 100 });
  });
});
