import { expect } from '@playwright/test';
import { DEAL_ROLE } from '@/lib/constants/roles';
import { EXTERNAL_EMAIL } from '../auth/session';
import { expectSingleComplianceInstrument } from '../support/selectors';
import type { Step } from './types';

export const grantExternalSeat: Step = {
  name: 'grantExternalSeat',

  async act(ctx) {
    const ref = ctx.state.dealCode as string;
    const response = await ctx.evidence.request.post(
      `/api/v1/deals/${encodeURIComponent(ref)}/members`,
      { data: { email: EXTERNAL_EMAIL, dealRole: DEAL_ROLE.SELLER } },
    );
    expect(response.status(), await response.text()).toBe(201);

    await ctx.page.goto(`/projects/${encodeURIComponent(ref)}/team`);
  },

  async assertUi(ctx) {
    await expect(
      ctx.page
        .getByRole('region', { name: 'Team roster' })
        .getByRole('button', { name: new RegExp(EXTERNAL_EMAIL.replace(/\./g, '\\.')) }),
    ).toBeVisible();
  },

  async verify(ctx) {
    const ref = ctx.state.dealCode as string;
    const { members } = await ctx.evidence.getDeal(ref);
    const seat = members.find((member) => member.user?.email === EXTERNAL_EMAIL);
    expect(seat, `${EXTERNAL_EMAIL} holds no seat on ${ref}`).toBeTruthy();
    expect(seat?.deal_role).toBe(DEAL_ROLE.SELLER);

    const me = await ctx.evidence.me();
    await ctx.evidence.expectAudit(ref, {
      action: 'grant',
      actorId: me.user.id,
      since: ctx.since,
    });

    await expectSingleComplianceInstrument(ctx.page);
  },
};
