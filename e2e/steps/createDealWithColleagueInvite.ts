import { expect } from '@playwright/test';
import { expectSingleComplianceInstrument } from '../support/selectors';
import { expectInvite } from '../support/invites';
import { runGate0Wizard } from './gate0';
import type { Step } from './types';

/**
 * Step 2 — open the mandate through Gate 0 with one queued colleague
 * invitation. Gate 0's queue is bank-internal by construction and can never
 * reach a scoped shell, so it is here for what it alone covers: how an
 * invitation is born on the real onboarding path, including the receipt
 * (design D11).
 */
export const createDealWithColleagueInvite: Step = {
  name: 'createDealWithColleagueInvite',

  async act(ctx) {
    // The bank's seeded verified domain, so preflight returns 'match' and the
    // chip queues in one click. The run id keeps the pending-email unique
    // index from colliding with an earlier run.
    ctx.state.colleagueEmail = `e2e-colleague-${ctx.runId}@futureproofing.com`;
    await runGate0Wizard(ctx, { inviteEmails: [ctx.state.colleagueEmail] });
  },

  async assertUi(ctx) {
    await ctx.page.waitForURL(/\/projects\/[^/]+\/rail/);
    const code = new URL(ctx.page.url()).pathname.split('/')[2];
    expect(code, 'no deal code in the landing URL').toBeTruthy();
    ctx.state.dealCode = decodeURIComponent(code);

    await expect(
      ctx.page.getByRole('heading', { name: `Project E2E ${ctx.runId}` }),
    ).toBeVisible();

    // The honest receipt. The banner reports invite outcomes as one summary
    // sentence and names addresses only for failures, so "1 invitation sent."
    // IS the per-chip success statement; the chip's identity is proven durably
    // in verify() below.
    const receipt = ctx.page.getByRole('status', { name: 'Mandate opened' });
    await expect(receipt).toBeVisible();
    await expect(receipt).toContainText('1 invitation sent.');
  },

  async verify(ctx) {
    const ref = ctx.state.dealCode as string;
    const { deal } = await ctx.evidence.getDeal(ref);
    ctx.state.dealId = deal.id;
    expect(deal.codename).toBe(`Project E2E ${ctx.runId}`);

    const me = await ctx.evidence.me();
    await ctx.evidence.expectAudit(ref, {
      action: 'create',
      actorId: me.user.id,
      since: ctx.since,
    });

    await expectInvite(ctx.evidence.request, ref, ctx.state.colleagueEmail as string, {
      status: 'pending',
      deliveryStatus: 'sent',
    });

    await expectSingleComplianceInstrument(ctx.page);
  },
};
