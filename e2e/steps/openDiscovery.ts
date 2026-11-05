import { expect } from '@playwright/test';
import { assertSeededMailPath } from '../support/mailPath';
import { escapeRegExp } from '../support/regexp';
import type { Step } from './types';

/** The proposed deals the demo seeds for Storm, and the one only a colleague's mail found. */
export const DEMO_VISIBLE = ['Project Kestrel', 'Project Harbor', 'Project Osprey', 'Project Falcon'] as const;

/**
 * Beat 1: Storm opens /discovery. Kestrel, Harbor, Osprey and Falcon are there;
 * Cobra, which only a colleague's mail found, is not. The candidate ids are read
 * off the rows so later beats can name a candidate without a second lookup.
 */
export const openDiscovery: Step = {
  name: 'openDiscovery',

  async act(ctx) {
    // Provider-neutral: the project's metadata says which path, the DB says which path was seeded.
    // First, before anything mutates: a stack seeded for the other path fails here, untouched.
    await assertSeededMailPath();
    await ctx.page.goto('/discovery');
  },

  async assertUi(ctx) {
    const { page } = ctx;
    await expect(page.getByRole('heading', { level: 1, name: 'Proposed deals' })).toBeVisible();
    for (const name of DEMO_VISIBLE) {
      await expect(page.getByRole('heading', { name: new RegExp(`^${escapeRegExp(name)}$`) })).toBeVisible();
    }
    await expect(page.getByRole('heading', { name: 'Project Cobra' })).toHaveCount(0);

    const ids: Record<string, string> = {};
    for (const name of DEMO_VISIBLE) {
      const row = page.locator('[data-candidate-id]').filter({
        has: page.getByRole('heading', { name: new RegExp(`^${escapeRegExp(name)}$`) }),
      });
      ids[name] = (await row.getAttribute('data-candidate-id')) as string;
    }
    ctx.state.candidateIds = ids;
  },

  async verify(ctx) {
    // The same list as the MD's own session reads it: what the page shows is what the API answered.
    const res = await ctx.evidence.request.get('/api/v1/discovery/candidates');
    expect(res.status(), 'GET /api/v1/discovery/candidates').toBe(200);
    const names = ((await res.json()) as { candidates: Array<{ name: string }> }).candidates.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining([...DEMO_VISIBLE]));
    expect(names).not.toContain('Project Cobra');
  },
};
