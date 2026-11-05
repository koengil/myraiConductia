/**
 * Claude list prices, USD per million tokens (Anthropic first-party API,
 * cached 2026-06-24). Cache reads bill at 10% of input, cache writes at 125%.
 * Unknown models price to null: the tokens stay on record, the dollar column
 * says "not priced" instead of guessing.
 */
const PRICE_PER_MTOK: Record<string, { input: number; output: number; cacheRead?: number }> = {
  // Fable 5.1 publishes a flat $0.25/MTok cache-read rate, not 10% of input.
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  // Haiku 5.5, the demo-only deal proposal model (#460). From the Vercel AI Gateway catalog
  // snapshot of 2026-10-09 (anthropic ZDR endpoint), not yet checked against Anthropic's list.
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01 },
};

/** Model ids as the AI Gateway spells them, mapped to their key above. */
const GATEWAY_SPELLINGS: ReadonlyMap<string, string> = new Map([['claude-haiku-5.5', 'claude-haiku-5-5']]);

const CACHE_READ_FACTOR = 0.1;
const CACHE_WRITE_FACTOR = 1.25;

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

/** The pricing key for a model id, tolerating dated snapshots ("-20260401"). */
export function pricingKeyFor(model: string): string | null {
  const trimmed = GATEWAY_SPELLINGS.get(model.trim()) ?? model.trim();
  if (PRICE_PER_MTOK[trimmed]) return trimmed;
  const undated = trimmed.replace(/-\d{8}$/, '');
  return PRICE_PER_MTOK[undated] ? undated : null;
}

/** USD for one call, rounded to 6 decimals; null when the model is not priced. */
export function costForUsage(model: string, usage: TokenUsage): number | null {
  const key = pricingKeyFor(model);
  if (!key) return null;
  const price = PRICE_PER_MTOK[key];
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const usd =
    (usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      cacheRead * (price.cacheRead ?? price.input * CACHE_READ_FACTOR) +
      cacheWrite * price.input * CACHE_WRITE_FACTOR) /
    1_000_000;
  return Math.round(usd * 1_000_000) / 1_000_000;
}
