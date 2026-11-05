import { expect } from '@playwright/test';
import {
  acceptUrlFrom,
  MAIL_STUB_URL,
  messagesFor,
  verificationCodeFrom,
  type StubMessage,
} from '../support/inbox';
import { expectInvite } from '../support/invites';
import { requireEvidence } from './types';
import type { Step } from './types';

/**
 * Step 4 — read the two invitation emails out of the stub. The only step with
 * no browser action: the assertion IS the mail.
 *
 * Order matters and is asserted. deliverInvite sends the non-actionable code
 * FIRST, so that a failure there means no credential has escaped; sending the
 * link first could leave an invitee holding a valid link that acceptance
 * rejects because delivery never finalized
 * (src/lib/api/v1/inviteDelivery.ts). Idempotency keys are asserted because
 * they are what makes retrying a transient provider failure safe.
 */
export const readInviteMail: Step = {
  name: 'readInviteMail',

  async act(ctx) {
    const email = ctx.state.directorEmail as string;
    const messages = await messagesFor(email, { expect: 2 });

    expect(
      messages,
      `expected exactly two messages for ${email}; saw ${messages.length}`,
    ).toHaveLength(2);

    const [code, link] = messages;
    expect(code.subject).toMatch(/^Your Conductia verification code \(\d+\)$/);
    expect(link.subject).toBe('You have a Conductia invitation');
    expect(code.seq, 'the code email must arrive before the link email').toBeLessThan(
      link.seq,
    );

    const inviteId = ctx.state.inviteId as string;
    expect(code.idempotencyKey).toBe(`invite-${inviteId}-challenge-1-code`);
    expect(link.idempotencyKey).toBe(`invite-${inviteId}-challenge-1-link`);

    ctx.state.inviteVerificationCode = verificationCodeFrom(code.html);
    ctx.state.inviteAcceptUrl = acceptUrlFrom(link.html);

    // Compliance property (src/lib/email/resend.ts): the six-digit challenge
    // is kept out of the action-link email deliberately, so that the invitee,
    // never the inviter, receives it — a code sent to the firm admin as well
    // would be a non-actionable secret leaked to a party who never needed it.
    // messagesFor(email, {expect: 2}) above only proves the director's own
    // inbox got two messages; it says nothing about what else the stub
    // captured. Read the whole stub, unfiltered, and prove the code email was
    // sent to exactly one recipient, the director, and to no one else —
    // ruling out the admin address specifically and any other address in
    // general, which is the stronger statement of the same property.
    const all = (await (await fetch(`${MAIL_STUB_URL}/messages`)).json()) as {
      messages: StubMessage[];
    };
    const codeMessages = all.messages.filter((message) => message.id === code.id);
    expect(codeMessages, 'the code message vanished from the unfiltered capture').toHaveLength(1);
    expect(
      codeMessages[0].to,
      'the verification code was sent to more than just the invitee',
    ).toEqual([email]);
  },

  async assertUi(ctx) {
    // No browser surface. The two artifacts the rest of the journey needs are
    // the assertion.
    expect(ctx.state.inviteVerificationCode).toMatch(/^\d{6}$/);
    expect(ctx.state.inviteAcceptUrl).toContain('/auth/v1/verify');
    // The redirect origin matches HERMETIC_BASE_URL (playwright.config.ts),
    // not the server's --hostname bind address: the app's route handlers
    // derive it from `new URL(request.url).origin`, which under `next start`
    // resolves to http://localhost:<port> regardless of the Host header the
    // client actually sent.
    expect(decodeURIComponent(ctx.state.inviteAcceptUrl as string)).toContain(
      'http://localhost:3000/accept-invite',
    );
  },

  async verify(ctx) {
    // finalize_invite_delivery ran: the row says sent, which is the durable
    // consequence of both emails having left.
    const adminEvidence = requireEvidence(ctx.adminEvidence, 'readInviteMail');
    await expectInvite(
      adminEvidence.request,
      ctx.state.dealCode as string,
      ctx.state.directorEmail as string,
      { status: 'pending', deliveryStatus: 'sent' },
    );
  },
};
