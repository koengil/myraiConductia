import { describe, expect, it } from 'vitest';

import { costForUsage, pricingKeyFor } from '../src/lib/ai/pricing';
import { ledgerUsage, usageFromAnthropicReply } from '../src/lib/ai/usage';

/*
 * AI cost tracking (#109): the price table and the usage reader are the only
 * arithmetic in the feature. Rates are the Anthropic list prices per MTok;
 * cache reads bill at 10%, cache writes at 125% of input.
 */

describe('costForUsage', () => {
  it('prices Sonnet 5 input and output at $2 / $10 per MTok', () => {
    expect(costForUsage('claude-sonnet-5', { inputTokens: 1_000_000, outputTokens: 0 })).toBe(2);
    expect(costForUsage('claude-sonnet-5', { inputTokens: 0, outputTokens: 1_000_000 })).toBe(10);
    expect(costForUsage('claude-sonnet-5', { inputTokens: 1_500, outputTokens: 300 })).toBe(0.006);
  });

  it('bills cache reads at 10% and cache writes at 125% of the input rate', () => {
    expect(
      costForUsage('claude-opus-5', {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 1_000_000,
      }),
    ).toBe(0.5 + 6.25);
  });

  it('prices Haiku 5.5 under both spellings, the gateway dotted one and the dashed key', () => {
    // The demo-only deal proposal model (#460); rates from the gateway catalog snapshot of 2026-10-09.
    expect(pricingKeyFor('claude-haiku-5.5')).toBe('claude-haiku-5-5');
    expect(pricingKeyFor('claude-haiku-5-5')).toBe('claude-haiku-5-5');
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 };
    expect(costForUsage('claude-haiku-5.5', usage)).toBe(0.735); // 0.10 in + 0.50 out + 0.01 cache read + 0.125 cache write (125% of input)
    expect(costForUsage('claude-haiku-5-5', usage)).toBe(costForUsage('claude-haiku-5.5', usage));
    expect(pricingKeyFor('claude-haiku-5.6')).toBeNull();
  });

  it('tolerates a dated snapshot id and refuses to guess an unknown model', () => {
    expect(pricingKeyFor('claude-sonnet-5-20260301')).toBe('claude-sonnet-5');
    expect(pricingKeyFor('gpt-5')).toBeNull();
    expect(costForUsage('some-future-model', { inputTokens: 10, outputTokens: 10 })).toBeNull();
  });
});

describe('usageFromAnthropicReply', () => {
  it('reads model and the four token counters from a Messages API reply', () => {
    expect(
      usageFromAnthropicReply({
        model: 'claude-sonnet-5',
        usage: {
          input_tokens: 812,
          output_tokens: 96,
          cache_read_input_tokens: 400,
          cache_creation_input_tokens: 0,
        },
      }),
    ).toEqual({
      model: 'claude-sonnet-5',
      inputTokens: 812,
      outputTokens: 96,
      cacheReadTokens: 400,
      cacheWriteTokens: 0,
    });
  });

  it('returns null without a usage block or a model', () => {
    expect(usageFromAnthropicReply({ content: [] })).toBeNull();
    expect(usageFromAnthropicReply({ usage: { input_tokens: 1 } })).toBeNull();
    expect(usageFromAnthropicReply(null)).toBeNull();
  });
});

describe('ledgerUsage', () => {
  const usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 };

  it('strips the gateway provider prefix so the price table matches', () => {
    const ledger = ledgerUsage({ model: 'anthropic/claude-sonnet-5', ...usage });
    expect(ledger).toEqual({ model: 'claude-sonnet-5', ...usage });
    expect(costForUsage(ledger!.model, ledger!)).not.toBeNull();
  });

  it('leaves a bare model alone, and passes null through', () => {
    expect(ledgerUsage({ model: 'claude-sonnet-5', ...usage })?.model).toBe('claude-sonnet-5');
    expect(ledgerUsage(null)).toBeNull();
  });
});
