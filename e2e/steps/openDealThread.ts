import { expect } from '@playwright/test';
import { expectSingleComplianceInstrument } from '../support/selectors';
import type { Step } from './types';

/**
 * #339: the promoted deal's Deal email view opens a thread from Storm's own
 * mailbox, with the message bodies, and Reply opens the compliant composer
 * addressed to the newest sender with a "Re:" subject. Nothing is sent: the
 * composer is discarded.
 */
export function openDealThread(opts: { subject: string }): Step {
  return {
    name: `openDealThread · ${opts.subject}`,

    async act(ctx) {
      const { page } = ctx;
      await page.goto(`/projects/${encodeURIComponent(ctx.state.dealCode as string)}/deal-folder`);
      await page.getByRole('tablist', { name: 'Deal Folder view' }).getByRole('tab', { name: 'Deal email' }).click();
      const list = page.getByRole('region', { name: 'Deal email' });
      await list.getByRole('button', { name: new RegExp(opts.subject) }).first().click();
    },

    async assertUi(ctx) {
      const { page } = ctx;
      const thread = page.getByRole('region', { name: 'Deal thread' });
      await expect(thread.getByRole('article').first()).toBeVisible();
      await expect(thread.getByRole('heading', { level: 2 })).toContainText(opts.subject);
      await thread.getByRole('button', { name: 'Reply' }).click();
      await expect(page.getByLabel(/^subject$/i)).toHaveValue(/^(\[Confidential\] )?Re: /);
      await expect(page.getByLabel(/^to$/i)).not.toHaveValue('');
      await page.getByRole('button', { name: /discard/i }).click();
      await expect(thread.getByRole('button', { name: 'Reply' })).toBeVisible();
    },

    async verify(ctx) {
      await expectSingleComplianceInstrument(ctx.page);
    },
  };
}
