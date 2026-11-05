import { expect } from '@playwright/test';
import { acceptUrlFrom, latestPairFor, verificationCodeFrom } from '../support/inbox';
import { expectInvite } from '../support/invites';
import { requireEvidence } from './types';
import type { Step } from './types';

/** Two deliveries have landed for the director by now: the original and the resend. */
const MESSAGES_AFTER_RESEND = 4;

export const readRotatedInviteMail: Step = {
  name: 'readRotatedInviteMail',

  async act(ctx) {
    const email = ctx.state.directorEmail as string;
    const { code, link } = await latestPairFor(email, MESSAGES_AFTER_RESEND);

    expect(code.subject).toBe('Your Conductia verification code (2)');
    expect(link.subject).toBe('You have a Conductia invitation');
    expect(code.seq, 'the code email must arrive before the link email').toBeLessThan(link.seq);

    const inviteId = ctx.state.inviteId as string;
    expect(code.idempotencyKey).toBe(`invite-${inviteId}-challenge-2-code`);
    expect(link.idempotencyKey).toBe(`invite-${inviteId}-challenge-2-link`);

    ctx.state.previousInviteVerificationCode = ctx.state.inviteVerificationCode;
    ctx.state.previousInviteAcceptUrl = ctx.state.inviteAcceptUrl;
    ctx.state.inviteVerificationCode = verificationCodeFrom(code.html);
    ctx.state.inviteAcceptUrl = acceptUrlFrom(link.html);
  },

  async assertUi(ctx) {
    expect(ctx.state.inviteVerificationCode).toMatch(/^\d{6}$/);
    expect(
      ctx.state.inviteVerificationCode,
      'the resend re-delivered the same verification code',
    ).not.toBe(ctx.state.previousInviteVerificationCode);
    expect(ctx.state.inviteAcceptUrl).toContain('/auth/v1/verify');
    expect(
      ctx.state.inviteAcceptUrl,
      'the resend re-delivered the same action link',
    ).not.toBe(ctx.state.previousInviteAcceptUrl);
  },

  async verify(ctx) {
    const adminEvidence = requireEvidence(ctx.adminEvidence, 'readRotatedInviteMail');
    await expectInvite(
      adminEvidence.request,
      ctx.state.dealCode as string,
      ctx.state.directorEmail as string,
      { status: 'pending', deliveryStatus: 'sent' },
    );
  },
};
