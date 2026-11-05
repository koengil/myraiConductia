import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { recordAiUsage } = vi.hoisted(() => ({
  recordAiUsage: vi.fn<(admin: unknown, row: unknown) => Promise<{ error: null }>>(async () => ({ error: null })),
}));
vi.mock('@/lib/ai/usage', () => ({ recordAiUsage }));

import { ledgerModelOf } from '@/lib/ignatious/benchMeter';
import { authoringUsageOf, authoringUsageRecorder } from '@/lib/skillAuthoring/authoringUsage';

/*
 * Skill builder spend on the AI cost ledger (#155): the bench prices each
 * authoring and enhancement turn on its done line (agents-backend PR #147),
 * and agent runs name their models in run.modelIds.
 */

function admin(tenantId: string | null) {
  const builder: Record<string, unknown> = {};
  for (const k of ['select', 'eq']) builder[k] = () => builder;
  builder.maybeSingle = async () => ({ data: tenantId ? { tenant_id: tenantId } : null, error: null });
  return { from: vi.fn(() => builder) } as never;
}

beforeEach(() => recordAiUsage.mockClear());
afterEach(() => vi.restoreAllMocks());

describe('authoringUsageOf', () => {
  it('prefers the catalog id and strips its namespace', () => {
    expect(authoringUsageOf({ type: 'done', costUsd: 0.02, model: 'sonnet', modelId: 'anthropic/claude-sonnet-5' })).toEqual({
      model: 'claude-sonnet-5',
      costUsd: 0.02,
    });
  });

  it('falls back to the alias, and keeps an unknown cost null', () => {
    expect(authoringUsageOf({ type: 'done', model: 'opus' })).toEqual({ model: 'opus', costUsd: null });
    expect(authoringUsageOf({ type: 'done' })).toEqual({ model: null, costUsd: null });
  });
});

describe('authoringUsageRecorder', () => {
  it('writes one skill_authoring row for the asking user, keyed by attempt id', async () => {
    await authoringUsageRecorder(admin('tenant-1'), { actorId: 'u-1', dealId: 'deal-1' })(
      'att-1',
      'skill_enhancement',
      { model: 'claude-sonnet-5', costUsd: 0.05 },
    );
    expect(recordAiUsage).toHaveBeenCalledOnce();
    expect(recordAiUsage.mock.calls[0][1]).toEqual({
      tenantId: 'tenant-1',
      dealId: 'deal-1',
      actorId: 'u-1',
      source: 'skill_authoring',
      task: 'skill_enhancement',
      externalId: 'att-1',
      model: 'claude-sonnet-5',
      costUsd: 0.05,
    });
  });

  it('records a firm catalog draft with no deal', async () => {
    await authoringUsageRecorder(admin('tenant-1'), { actorId: 'u-1', dealId: null })('att-2', 'catalog_skill_authoring', {
      model: null,
      costUsd: 0.01,
    });
    expect(recordAiUsage.mock.calls[0][1]).toMatchObject({ dealId: null, task: 'catalog_skill_authoring' });
  });

  it('writes nothing, and never throws, when the user has no tenant', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      authoringUsageRecorder(admin(null), { actorId: 'u-1', dealId: null })('att-3', 'skill_authoring', { model: null, costUsd: 1 }),
    ).resolves.toBeUndefined();
    expect(recordAiUsage).not.toHaveBeenCalled();
  });
});

describe('ledgerModelOf', () => {
  it('names every model a run called, bare and once each', () => {
    expect(ledgerModelOf(['anthropic/claude-sonnet-5', 'anthropic/claude-haiku-5', 'anthropic/claude-sonnet-5'])).toBe(
      'claude-sonnet-5 + claude-haiku-5',
    );
    expect(ledgerModelOf([])).toBeNull();
  });
});
