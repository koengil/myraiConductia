import { createDeal } from './createDeal';
import { runGate0Wizard } from './gate0';
import type { Step } from './types';

export const createDealFromLeadSearch: Step = {
  name: 'createDealFromLeadSearch',

  async act(ctx) {
    await runGate0Wizard(ctx, { leadQuery: ctx.runId });
  },

  assertUi: createDeal.assertUi,
  verify: createDeal.verify,
};
