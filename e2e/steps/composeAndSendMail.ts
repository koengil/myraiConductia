import { expect } from '@playwright/test';
import { expectSingleComplianceInstrument } from '../support/selectors';
import type { Step } from './types';

const RECIPIENT = 'e2e.counterparty@dev.com';
// Deliberately routine logistics: no promissory commitment, no MNPI signal.
const BODY = 'Confirming the working session on Thursday at ten. The agenda follows tomorrow.';

/**
 * Step 5 — the compliance email client. Nothing leaves unscreened: the fast
 * layer runs as you type, the full layer runs server-side on send, and the
 * verdict decides the outcome. Under EMAIL_PROVIDER=noop the send succeeds and
 * is marked simulated, so screen -> verdict -> outbox is exercised end to end.
 */
export const composeAndSendMail: Step = {
  name: 'composeAndSendMail',

  async act(ctx) {
    const draftSubject = `E2E Spine ${ctx.runId}`;
    // Gate 0 creates a live deal. Keep the input unmarked so this journey
    // proves both the automatic preview and the actual retained subject.
    ctx.state.mailSubject = `[Confidential] ${draftSubject}`;

    await ctx.page.goto(`/projects/${encodeURIComponent(ctx.state.dealCode as string)}/mail`);
    await ctx.page.getByRole('button', { name: 'New message' }).click();

    const composer = ctx.page.getByRole('region', { name: 'Compose email' });
    await expect(composer).toBeVisible();
    await composer.getByLabel('To').fill(RECIPIENT);
    await composer.getByPlaceholder('Subject').fill(draftSubject);
    await expect(composer.getByLabel('Email subject preview', { exact: true })).toHaveText(ctx.state.mailSubject);
    await composer.getByRole('textbox', { name: 'Message' }).click();
    await ctx.page.keyboard.type(BODY);
    await composer.getByRole('button', { name: 'Send' }).click();
    // D81: an outsider not on the deal is confirmed in To too, so the
    // recipient review opens and the banker approves before the send.
    const reviewDialog = ctx.page.getByRole('dialog', { name: 'Review email recipients' });
    await expect(reviewDialog).toBeVisible();
    // The label depends on the firm's verified domains: a verified outsider
    // new to the deal is sent and added as a known recipient (Issue #378).
    await reviewDialog
      .getByRole('button', { name: /^(Approve recipients and continue|Send anyway and add as known recipients?)$/ })
      .click();
    await expect(
      ctx.page
        .getByRole('region', { name: 'Message list' })
        .getByRole('button', { name: ctx.state.mailSubject as string }),
    ).toBeVisible();
  },

  async assertUi(ctx) {
    // A successful send clears the composer and switches straight to the
    // Sent folder in the same commit (MailClient's onSent), so the
    // composer's "Screened and delivered to the provider." receipt banner
    // never has a chance to render — the send flow lands on the Sent list
    // instead. The durable, actually-observable outcome is the sent row.
    await expect(
      ctx.page
        .getByRole('region', { name: 'Message list' })
        .getByRole('button', { name: ctx.state.mailSubject as string }),
    ).toBeVisible();
  },

  async verify(ctx) {
    const { messages } = await ctx.evidence.listOutbox(ctx.state.dealCode as string);
    const sent = messages.find((message) => message.subject === ctx.state.mailSubject);
    expect(sent, `no outbox receipt for "${ctx.state.mailSubject}"`).toBeTruthy();
    expect(sent?.status).toBe('sent');
    expect(sent?.verdict).toBe('compliant');
    expect(sent?.to).toContain(RECIPIENT);
    // The hermetic tier runs the noop transport: the send is real end to end
    // and nothing left the building.
    if (!process.env.E2E_BASE_URL) {
      expect(sent?.provider).toBe('noop');
      expect(sent?.llmChecked).toBe(false);
    }

    const ref = ctx.state.dealCode as string;
    const me = await ctx.evidence.me();
    await ctx.evidence.expectAudit(ref, { action: 'screen', actorId: me.user.id, since: ctx.since });
    await ctx.evidence.expectAudit(ref, { action: 'send', actorId: me.user.id, since: ctx.since });

    await expectSingleComplianceInstrument(ctx.page);
  },
};
