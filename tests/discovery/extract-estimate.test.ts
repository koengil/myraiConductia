import { describe, expect, it } from 'vitest';

import {
  CEILING_BYTES_PER_TOKEN,
  describeSizes,
  ESTIMATE_ASSUMPTIONS,
  EXTRACT_ESTIMATE_MARGIN,
  estimateExtraction,
  estimateOnce,
  OVERHEAD_BYTES_PER_ITEM,
  toExtractStats,
  type ExtractStats,
} from '@/lib/discovery/extract/estimate';
import { DEFAULT_EXTRACT_MODEL } from '@/lib/modelGateway/processorGate';

import calibration from '../fixtures/discovery/calibration/extract-v1.json';

const dist = (total: number, mean: number, median: number, p95: number, max: number) => ({ total, mean, median, p95, max });
const STATS: ExtractStats = { items: 10, threads: 4, bodyBytes: dist(35_000, 3_500, 3_000, 8_000, 9_000), subjectBytes: dist(500, 50, 48, 80, 80) };
const { bytesPerToken: BPT, outputTokensPerItem: OUT } = ESTIMATE_ASSUMPTIONS;

describe('estimateExtraction', () => {
  it('measures the prompt overhead from the prompt itself', () => {
    expect(OVERHEAD_BYTES_PER_ITEM).toBeGreaterThan(2_300);
    expect(OVERHEAD_BYTES_PER_ITEM).toBeLessThan(2_600);
  });

  it('turns synthetic stats into tokens and dollars by the documented formula', () => {
    const e = estimateExtraction(STATS);
    const inputTokens = Math.ceil((10 * OVERHEAD_BYTES_PER_ITEM + 500 + 35_000) / BPT);
    expect(e.model).toBe(DEFAULT_EXTRACT_MODEL);
    expect(e.inputTokens).toBe(inputTokens);
    expect(e.outputTokens).toBe(10 * OUT);
    expect(e.costUsd).toBeCloseTo((inputTokens * 2 + 10 * OUT * 10) / 1e6, 6);
    expect(e.ceilingOutputTokens).toBe(10 * 2048);
    const headroom = ((2048 - OUT) * 10) / 1e6;
    expect(e.stopAtUsd).toBeCloseTo(Math.max(e.costUsd * (1 + EXTRACT_ESTIMATE_MARGIN), e.costUsd + headroom), 5); // stopAtUsd is rounded to 6 decimals
  });

  it('measures the per-call ceiling input at its own, denser ratio and prints it (m-5)', () => {
    const e = estimateExtraction(STATS);
    const ceilingInput = Math.ceil((10 * OVERHEAD_BYTES_PER_ITEM + 500 + 35_000) / CEILING_BYTES_PER_TOKEN);
    expect(CEILING_BYTES_PER_TOKEN).toBe(2.0);
    expect(e.assumptions).toMatchObject({ bytesPerToken: BPT, ceilingBytesPerToken: 2.0 });
    expect(e.ceilingCostUsd).toBeCloseTo((ceilingInput * 2 + 10 * 2048 * 10) / 1e6, 6);
    expect(e.ceilingCostUsd).toBeGreaterThan(e.costUsd);
    expect(e.inputTokens).toBe(Math.ceil((10 * OVERHEAD_BYTES_PER_ITEM + 500 + 35_000) / BPT)); // the expected cost keeps its own ratio
  });

  it('is zero for an empty set', () => {
    const empty = { items: 0, threads: 0, bodyBytes: describeSizes([]), subjectBytes: describeSizes([]) };
    expect(estimateExtraction(empty)).toMatchObject({ inputTokens: 0, outputTokens: 0, costUsd: 0, stopAtUsd: 0 });
  });

  it('refuses an unpriced model (fail closed)', () => {
    expect(() => estimateExtraction(STATS, 'anthropic/not-in-pricing')).toThrow(/unpriced_model/);
  });

  it('carries numbers, null and the model id only', () => {
    const leaves: unknown[] = [];
    const walk = (v: unknown): void => (v && typeof v === 'object' ? Object.values(v).forEach(walk) : void leaves.push(v));
    walk(estimateExtraction(STATS));
    expect(leaves.every((v) => typeof v === 'number' || v === null || v === DEFAULT_EXTRACT_MODEL)).toBe(true);
  });

  it('uses the calibrated figures, or the documented fallback', () => {
    if (calibration.source === 'fallback') expect([BPT, OUT]).toEqual([3.0, 600]);
    else {
      const measured = calibration as unknown as { inputBytes: number; inputTokens: number; outputP95: number };
      expect(BPT).toBe(Math.floor((measured.inputBytes / measured.inputTokens) * 4) / 4);
      expect(OUT).toBe(Math.ceil(measured.outputP95 / 50) * 50);
    }
  });
});

describe('describeSizes', () => {
  it('interpolates like percentile_cont and rounds like round(numeric)', () => {
    // median 2.5 -> 3 (round(numeric) rounds a half away from zero; round(float8) would give 2), p95 3.85 -> 4, mean 2.5 -> 3
    expect(describeSizes([1, 2, 3, 4])).toEqual({ total: 10, mean: 3, median: 3, p95: 4, max: 4 });
    expect(describeSizes([])).toEqual({ total: 0, mean: 0, median: 0, p95: 0, max: 0 });
  });
});

describe('toExtractStats', () => {
  const ROW = { items: 2, threads: '1', bodyBytes: dist(10, 5, 5, 6, 6), subjectBytes: dist(4, 2, 2, 3, 3) };
  it('reads numbers, including numeric strings, and nothing else', () => {
    expect(toExtractStats(ROW)).toEqual({ items: 2, threads: 1, bodyBytes: dist(10, 5, 5, 6, 6), subjectBytes: dist(4, 2, 2, 3, 3) });
  });
  it('throws a fixed code, never the value, on a missing or non-numeric leaf', () => {
    for (const bad of [null, [], { ...ROW, items: 'secret body' }, { ...ROW, bodyBytes: undefined }, { ...ROW, subjectBytes: { total: 1 } }]) {
      expect(() => toExtractStats(bad)).toThrow('extract stats failed: shape');
    }
  });
});

describe('estimateOnce', () => {
  it('reads only the stats port, on the pinned model', async () => {
    const seen: unknown[][] = [];
    const store = { extractStats: async (...a: unknown[]) => (seen.push(a), STATS) };
    await estimateOnce({ tenantId: '11111111-2222-4333-8444-555555555555', store });
    expect(seen).toEqual([['11111111-2222-4333-8444-555555555555', 'v1', DEFAULT_EXTRACT_MODEL]]);
  });
});
