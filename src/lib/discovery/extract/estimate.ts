// The extractor's pre-run estimate (#261, design Q4). Pure: statistics in, tokens and dollars out. Every
// assumption is a named number here, printed with the estimate, and the two measured ones cite their source.

import { costForUsage } from '@/lib/ai/pricing';
import { DEFAULT_EXTRACT_MODEL, ProcessorRefusedError } from '@/lib/modelGateway/processorGate';
import { PROMPT_VERSION, milestoneExtractV1 } from '@/lib/modelGateway/prompts/milestoneExtract.v1';
import { MAX_TOKENS } from '@/lib/modelGateway/transports';

import type { ExtractStore } from './run';

export type SizeDistribution = { total: number; mean: number; median: number; p95: number; max: number };
export type ExtractStats = { items: number; threads: number; bodyBytes: SizeDistribution; subjectBytes: SizeDistribution };

/**
 * Design Q4c, calibrated (M2). The figures come from the run recorded in
 * tests/fixtures/discovery/calibration/extract-v1.json, and tests/discovery/extract-estimate.test.ts fails if the
 * two disagree. They are repeated here because src/ never imports a test fixture.
 *
 * Calibration is pending the owner's gateway key, so both figures are the conservative fallback until a measured
 * run replaces them: 3.0 bytes per token (below the usual 3.5 to 4 for English prose, so tokens are overcounted)
 * and 600 output tokens per item (above what a reply with a handful of milestones needs).
 */
export const ESTIMATE_ASSUMPTIONS = {
  /** Σ input bytes / Σ input tokens over the calibration run, rounded down to 0.25 (fallback 3.0). */
  bytesPerToken: 3.0,
  /** p95 of output tokens over the calibration run, rounded up to 50 (fallback 600). */
  outputTokensPerItem: 600,
  /** None: the prompt sends the whole normalized body (milestoneExtract.v1.ts). */
  truncationBytes: null,
} as const;
/**
 * The per-call ceiling's own input assumption (m-5): base64, URLs and other dense content tokenize at fewer
 * bytes per token than prose, so a call's worst case measures its input at 2.0 bytes per token, not at the
 * 3.0 the expected cost uses. Output stays at MAX_TOKENS. The residual is documented in the AWS runbook: content
 * denser than this can overshoot the stop line by at most one call's excess input cost, because each call's
 * real usage is ledgered before the next check.
 */
export const CEILING_BYTES_PER_TOKEN = 2.0;
/** Owner number (design Q4c): the stop line sits this fraction above the estimate. */
export const EXTRACT_ESTIMATE_MARGIN = 0.25;

/** The system prompt plus the user template around subject and body, measured from the prompt itself. */
export const OVERHEAD_BYTES_PER_ITEM =
  Buffer.byteLength(milestoneExtractV1.system, 'utf8') +
  Buffer.byteLength(milestoneExtractV1.user({ subject: '', sentAt: '2026-01-01T00:00:00.000Z', body: '' }), 'utf8');

export type ExtractEstimate = {
  model: string;
  stats: ExtractStats;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  ceilingOutputTokens: number;
  ceilingCostUsd: number;
  stopAtUsd: number;
  assumptions: {
    bytesPerToken: number;
    ceilingBytesPerToken: number;
    overheadBytesPerItem: number;
    outputTokensPerItem: number;
    maxTokensPerItem: number;
    truncationBytes: null;
    margin: number;
  };
};

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
const priced = (model: string) => model.replace(/^anthropic\//, ''); // the pricing table keys "claude-sonnet-5"

function costOrRefuse(model: string, inputTokens: number, outputTokens: number): number {
  const usd = costForUsage(priced(model), { inputTokens, outputTokens });
  if (usd === null) throw new ProcessorRefusedError('unpriced_model'); // fail closed
  return usd;
}

export function estimateExtraction(
  stats: ExtractStats,
  model: string = DEFAULT_EXTRACT_MODEL,
  margin = EXTRACT_ESTIMATE_MARGIN,
): ExtractEstimate {
  const a = ESTIMATE_ASSUMPTIONS;
  const inputTokens = Math.ceil(
    (stats.items * OVERHEAD_BYTES_PER_ITEM + stats.subjectBytes.total + stats.bodyBytes.total) / a.bytesPerToken,
  );
  const outputTokens = stats.items * a.outputTokensPerItem;
  const ceilingOutputTokens = stats.items * MAX_TOKENS;
  const costUsd = costOrRefuse(model, inputTokens, outputTokens);
  // The ceiling measures input at its own, denser bytes per token (m-5).
  const ceilingInputTokens = Math.ceil(
    (stats.items * OVERHEAD_BYTES_PER_ITEM + stats.subjectBytes.total + stats.bodyBytes.total) / CEILING_BYTES_PER_TOKEN,
  );
  const ceilingCostUsd = costOrRefuse(model, ceilingInputTokens, ceilingOutputTokens);
  // One call's output headroom: a set that runs exactly to estimate can still send its last item under the
  // per-call ceiling check (LE-4, B2), and a very small set is not refused outright. It covers the output
  // part of a call's ceiling only; the input part is bounded by the 25% margin.
  const headroom = stats.items > 0 ? costOrRefuse(model, 0, MAX_TOKENS - a.outputTokensPerItem) : 0;
  return {
    model,
    stats,
    inputTokens,
    outputTokens,
    costUsd,
    ceilingOutputTokens,
    ceilingCostUsd,
    stopAtUsd: round6(Math.max(costUsd * (1 + margin), costUsd + headroom)),
    assumptions: {
      bytesPerToken: a.bytesPerToken,
      ceilingBytesPerToken: CEILING_BYTES_PER_TOKEN,
      overheadBytesPerItem: OVERHEAD_BYTES_PER_ITEM,
      outputTokensPerItem: a.outputTokensPerItem,
      maxTokensPerItem: MAX_TOKENS,
      truncationBytes: a.truncationBytes,
      margin,
    },
  };
}

/**
 * One call's worst case for an item: its input at CEILING_BYTES_PER_TOKEN and MAX_TOKENS out. The twin of
 * discovery_extract_ceiling_usd (SQL); tests/fixtures/discovery/extract/ceiling-cases.json holds both to the
 * same numbers. overheadBytes defaults to the prompt's own; the fixture pins it.
 */
export function ceilingCostFor(
  item: { subject: string; bodyText: string },
  model: string = DEFAULT_EXTRACT_MODEL,
  overheadBytes: number = OVERHEAD_BYTES_PER_ITEM,
): number {
  const bytes = overheadBytes + Buffer.byteLength(item.subject, 'utf8') + Buffer.byteLength(item.bodyText, 'utf8');
  return costOrRefuse(model, Math.ceil(bytes / CEILING_BYTES_PER_TOKEN), MAX_TOKENS);
}

/** The per-token input price and the output ceiling, handed to discovery_extract_budget_open so SQL and TS agree. */
export function ceilingPrices(model: string = DEFAULT_EXTRACT_MODEL): { inputUsdPerToken: number; outputCeilingUsd: number } {
  return { inputUsdPerToken: costOrRefuse(model, 1_000_000, 0) / 1_000_000, outputCeilingUsd: costOrRefuse(model, 0, MAX_TOKENS) };
}

/** The dry run: metadata only, on the pinned model (m1). It takes no transport, so it cannot call a model. */
export async function estimateOnce(opts: {
  tenantId: string;
  store: Pick<ExtractStore, 'extractStats'>;
}): Promise<ExtractEstimate> {
  return estimateExtraction(await opts.store.extractStats(opts.tenantId, PROMPT_VERSION, DEFAULT_EXTRACT_MODEL));
}

/**
 * percentile_cont with linear interpolation, then Math.round (= round(numeric) for non-negative sizes).
 * For the memory store and tests; the database computes the same figures in discovery_extract_stats.
 */
export function describeSizes(values: number[]): SizeDistribution {
  if (values.length === 0) return { total: 0, mean: 0, median: 0, p95: 0, max: 0 };
  const sorted = [...values].sort((x, y) => x - y);
  const percentile = (p: number): number => {
    const at = (sorted.length - 1) * p;
    const lo = Math.floor(at);
    const hi = Math.ceil(at);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
  };
  const total = sorted.reduce((sum, v) => sum + v, 0);
  return {
    total,
    mean: Math.round(total / sorted.length),
    median: Math.round(percentile(0.5)),
    p95: Math.round(percentile(0.95)),
    max: sorted[sorted.length - 1],
  };
}

/** The shape discovery_extract_stats returns: every leaf is a number, or this throws a code (never a value). */
export function toExtractStats(data: unknown): ExtractStats {
  const num = (v: unknown): number => {
    const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN;
    if (!Number.isFinite(n)) throw new Error('extract stats failed: shape');
    return n;
  };
  const obj = (v: unknown): Record<string, unknown> => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('extract stats failed: shape');
    return v as Record<string, unknown>;
  };
  const dist = (v: unknown): SizeDistribution => {
    const d = obj(v);
    return { total: num(d.total), mean: num(d.mean), median: num(d.median), p95: num(d.p95), max: num(d.max) };
  };
  const s = obj(data);
  return { items: num(s.items), threads: num(s.threads), bodyBytes: dist(s.bodyBytes), subjectBytes: dist(s.subjectBytes) };
}
