import { expect } from '@playwright/test';
import { expectInvite } from '../support/invites';
import { requireEvidence, requirePage } from './types';
import type { Step } from './types';

/** Proven in verify(): the seat granted at acceptance is the one previewed. */
const CONFIRMED_PHASE = 1;

/**
 * Step 3 — give the external director data room access from the Data Room.
 * Team's own invite brings colleagues at your firm only; an outside party's
 * access starts in the Data Room ("Give data room access", the shared
 * DealInvite in its data-room mode), on the same external seat and the same
 * POST /api/v1/invites.
 *
 * Driven by the FIRM ADMIN, not the MD. A company's first director invitation
 * is a company-management act: POST /api/v1/invites requires firm_role='admin'
 * or a directorship of the target company (route.ts:197-211, re-derived inside
 * create_invite). Storm is a director of the bank, not of the lead company the
 * journey just created, so the product refuses him — and says so on this very
 * screen: "A firm admin must send its first Company Director invitation."
 * A 'member' invite is refused too, 409 company_requires_director, because the
 * company has no active director yet.
 *
 * The company is the journey's own lead, seated as the deal's target party by
 * Gate 0, so nothing here depends on seed-onboarding-demo (design D10).
 */
export const inviteExternalDirector: Step = {
  name: 'inviteExternalDirector',

  async act(ctx) {
    const page = requirePage(ctx.adminPage, 'inviteExternalDirector');

    // A domain the lead company has not verified. The journey walks the
    // resulting confirmation rather than seeding around it: it is a real
    // safeguard on the flow carrying the most demo risk.
    ctx.state.directorEmail = `e2e-director-${ctx.runId}@e2e-external.test`;
    ctx.state.inviteePhase = CONFIRMED_PHASE;

    await page.goto(`/projects/${ctx.state.dealCode}/data-room`);
    await page.getByRole('button', { name: 'Give data room access' }).click();

    const modal = page.getByRole('dialog', { name: 'Give data room access' });
    await expect(modal).toBeVisible();

    await modal.getByLabel('Email').fill(ctx.state.directorEmail);
    await modal.getByLabel('Company').selectOption({ label: ctx.state.leadName as string });

    // The lookup reports companyRolePolicy { memberAllowed: false,
    // directorAllowed: true } for this actor and company, so Director is the
    // only Role option the form renders. Select it explicitly rather than rely
    // on the lookup's auto-fill landing first.
    await expect(modal.getByLabel('Role')).toBeVisible();
    await modal.getByLabel('Role').selectOption({ label: 'Director' });

    // Phase travels with the invitation and is the phase actually granted, so
    // set a non-zero one: phase 0 is indistinguishable from the default.
    await modal.getByLabel('Access up to').selectOption(String(CONFIRMED_PHASE));

    // First click runs preflight and surfaces the unverified-domain decision.
    await modal.getByRole('button', { name: 'Check and send invite' }).click();
    await expect(
      modal.getByRole('alert').filter({ hasText: 'no verified email domain' }),
    ).toBeVisible();

    // Second click sends, carrying the confirmation id.
    await modal.getByRole('button', { name: 'Confirm and send' }).click();
  },

  async assertUi(ctx) {
    const page = requirePage(ctx.adminPage, 'inviteExternalDirector');
    const modal = page.getByRole('dialog', { name: 'Give data room access' });
    await expect(
      modal.getByText(`Invite pending for ${ctx.state.directorEmail}`),
    ).toBeVisible();
    // No delivery failure alongside it — the stub accepted both sends.
    await expect(modal.getByText('Email failed. Resend.')).toHaveCount(0);

    await modal.getByRole('button', { name: 'Done' }).click();

    // Team now carries the pending row.
    await page.goto(`/projects/${ctx.state.dealCode}/team`);
    await expect(
      page.getByText(ctx.state.directorEmail as string, { exact: true }),
    ).toBeVisible();
  },

  async verify(ctx) {
    const ref = ctx.state.dealCode as string;
    const { request } = requireEvidence(ctx.adminEvidence, 'inviteExternalDirector');

    const invite = await expectInvite(request, ref, ctx.state.directorEmail as string, {
      status: 'pending',
      deliveryStatus: 'sent',
    });
    expect(invite.companyRole).toBe('director');
    // The lead company is the deal's target party, so its people take the
    // seller seat (create_invite derives this and refuses anything else).
    expect(invite.dealRole).toBe('seller');
    ctx.state.inviteId = invite.id;

    // The MD reads the audit: the send is on the deal's trail regardless of
    // which authorized identity made it.
    await ctx.evidence.expectAudit(ref, { action: 'invite_sent', since: ctx.since });
  },
};
