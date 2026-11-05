import { expect } from '@playwright/test';
import { inviteExternalDirector } from './inviteExternalDirector';
import type { Step } from './types';

/**
 * The same address, invited again after its invitation was revoked. Composed
 * from the original step rather than restated: the screen, the unverified
 * domain confirmation and the seat derivation are all unchanged, and the only
 * new claim is that a second invitation row was born.
 */
export const reinviteExternalDirector: Step = {
  name: 'reinviteExternalDirector',

  async act(ctx) {
    ctx.state.previousInviteId = ctx.state.inviteId;
    await inviteExternalDirector.act(ctx);
  },

  assertUi: inviteExternalDirector.assertUi,

  async verify(ctx) {
    await inviteExternalDirector.verify(ctx);
    expect(
      ctx.state.inviteId,
      'the re-invitation reused the revoked invite row',
    ).not.toBe(ctx.state.previousInviteId);
  },
};
