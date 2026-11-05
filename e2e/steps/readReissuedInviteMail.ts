import { expect } from '@playwright/test';
import { acceptUrlFrom, latestPairFor, verificationCodeFrom } from '../support/inbox';
import { expectInvite } from '../support/invites';
import { requireEvidence } from './types';
import type { Step } from './types';

/** Three deliveries by now: the original, the resend, and the re-invitation. */
const MESSAGES_AFTER_REINVITE = 6;

export const readReissuedInviteMail: Step = {
  name: 'readReissuedInviteMail',

  async act(ctx) {
    const email = ctx.state.directorEmail as string;
    const { code, link } = await latestPairFor(email, MESSAGES_AFTER_REINVITE);

    // A new invite row starts its challenge at version 1, so the counter in
    // the subject restarts with it.
    expect(code.subject).toBe('Your Conductia verification code (1)');
    expect(link.subject).toBe('You have a Conductia invitation');
    expect(code.seq, 'the code email must arrive before the link email').toBeLessThan(link.seq);

    const inviteId = ctx.state.inviteId as string;
    expect(code.idempotencyKey).toBe(`invite-${inviteId}-challenge-1-code`);
    expect(link.idempotencyKey).toBe(`invite-${inviteId}-challenge-1-link`);

    ctx.state.previousInviteVerificationCode = ctx.state.inviteVerificationCode;
    ctx.state.previousInviteAcceptUrl = ctx.state.inviteAcceptUrl;
    ctx.state.inviteVerificationCode = verificationCodeFrom(code.html);
    ctx.state.inviteAcceptUrl = acceptUrlFrom(link.html);
  },

  async assertUi(ctx) {
    expect(ctx.state.inviteVerificationCode).toMatch(/^\d{6}$/);
    expect(
      ctx.state.inviteVerificationCode,
      'the re-invitation re-delivered the revoked verification code',
    ).not.toBe(ctx.state.previousInviteVerificationCode);
    expect(decodeURIComponent(ctx.state.inviteAcceptUrl as string)).toContain(
      'http://localhost:3000/accept-invite',
    );
    expect(
      ctx.state.inviteAcceptUrl,
      'the re-invitation re-delivered the revoked action link',
    ).not.toBe(ctx.state.previousInviteAcceptUrl);
  },

  async verify(ctx) {
    const adminEvidence = requireEvidence(ctx.adminEvidence, 'readReissuedInviteMail');
    await expectInvite(
      adminEvidence.request,
      ctx.state.dealCode as string,
      ctx.state.directorEmail as string,
      { status: 'pending', deliveryStatus: 'sent' },
    );
  },
};
