import { expect } from '@playwright/test';
import { annotatePendingRecording } from '../support/recording';
import { expectSingleComplianceInstrument } from '../support/selectors';
import type { Step } from './types';

/**
 * Beat 7b: the rail's evidence marker reads "Evidence suggests Step 47 ·
 * Signing / Announcement Prep". Nothing moves on its own: Storm accepts it, and
 * the cursor moves through the rail's own PATCH /progress with its `advance`
 * audit row.
 */
export function acceptEvidenceSuggestion(opts: { station: number; title: string; seq: number }): Step {
  const nn = String(opts.station).padStart(2, '0');
  return {
    name: `acceptEvidenceSuggestion · Step ${nn}`,

    async act(ctx) {
      const { page } = ctx;
      await page.goto(`/projects/${encodeURIComponent(ctx.state.dealCode as string)}/rail`);
      const marker = page.getByRole('status', { name: 'Evidence suggestion' });
      await expect(marker).toContainText(`Evidence suggests Step ${nn} · ${opts.title}`);
      await marker.getByRole('button', { name: `Move rail to step ${nn}` }).click();
    },

    async assertUi(ctx) {
      annotatePendingRecording('beat 7');
      // Accepting hides the marker: the cursor now sits on the suggested step.
      await expect(ctx.page.getByRole('status', { name: 'Evidence suggestion' })).toHaveCount(0);
    },

    async verify(ctx) {
      const ref = ctx.state.dealCode as string;
      await expect
        .poll(async () => (await ctx.evidence.getDeal(ref)).deal.current_step_seq, {
          message: 'accepting the suggestion never moved the cursor',
        })
        .toBe(opts.seq);
      const me = await ctx.evidence.me();
      await ctx.evidence.expectAudit(ref, { action: 'advance', actorId: me.user.id, since: ctx.since });
      await expectSingleComplianceInstrument(ctx.page);
    },
  };
}
