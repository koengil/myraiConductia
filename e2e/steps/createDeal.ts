import { expect } from '@playwright/test';
import { expectSingleComplianceInstrument } from '../support/selectors';
import { runGate0Wizard } from './gate0';
import type { Step } from './types';

/**
 * Step 2 — open the mandate through Gate 0. The wizard is a dialog launched
 * from the sidebar deal switcher, not a route: the gate is a short ceremony and
 * the created deal owns the destination URL, not the wizard.
 */
export const createDeal: Step = {
  name: 'createDeal',

  async act(ctx) {
    await runGate0Wizard(ctx);
  },

  async assertUi(ctx) {
    // The wizard routes to /projects/{code}/rail?new=1 on success.
    await ctx.page.waitForURL(/\/projects\/[^/]+\/rail/);
    const code = new URL(ctx.page.url()).pathname.split('/')[2];
    expect(code, 'no deal code in the landing URL').toBeTruthy();
    ctx.state.dealCode = decodeURIComponent(code);

    await expect(
      ctx.page.getByRole('heading', { name: `Project E2E ${ctx.runId}` }),
    ).toBeVisible();
  },

  async verify(ctx) {
    const ref = ctx.state.dealCode as string;
    const { deal, members } = await ctx.evidence.getDeal(ref);
    ctx.state.dealId = deal.id;
    ctx.state.dealCodename = deal.codename;

    expect(deal.codename).toBe(`Project E2E ${ctx.runId}`);
    expect(deal.code).toBe(ref);

    const me = await ctx.evidence.me();
    const mine = members.find((member) => member.user?.id === me.user.id);
    expect(mine, 'the creating MD is not a member of the deal').toBeTruthy();

    await ctx.evidence.expectAudit(ref, {
      action: 'create',
      actorId: me.user.id,
      since: ctx.since,
    });

    await expectSingleComplianceInstrument(ctx.page);
  },
};

export function createDealEnteringAt(entryStep: string): Step {
  return {
    ...createDeal,
    name: `createDeal · entering at ${entryStep}`,
    act: (ctx) => runGate0Wizard(ctx, { entryStep }),
  };
}
