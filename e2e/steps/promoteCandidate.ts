import { expect } from '@playwright/test';
import { correctionsFor } from '../support/discoveryEvidence';
import { ZOOM_OUT, zoomIntoCurrentStep } from '../support/rail';
import { candidateId } from './openCandidate';
import type { Step } from './types';

/**
 * Beat 6: Storm promotes Kestrel into a real deal through the dialog. It runs
 * Gate 0's own controls (code name mask, conflicts attestation, MNPI screen), so
 * the receipt reads "Mandate opened from discovery" and the rail opens at the
 * step he chose, not at Gate 0's default.
 */
export function promoteCandidate(opts: {
  candidate: string;
  codename: string;
  target: string;
  station: number;
  title: string;
  seq: number;
  approver: string;
}): Step {
  const label = `${String(opts.station).padStart(2, '0')} · ${opts.title}`;
  return {
    name: `promoteCandidate · ${opts.candidate}`,

    async act(ctx) {
      const { page } = ctx;
      await page.goto(`/discovery/${candidateId(ctx, opts.candidate)}`);
      await page.getByRole('button', { name: 'Promote to mandate' }).click();
      const dialog = page.getByRole('dialog', { name: 'Open the mandate' });
      await dialog.getByRole('textbox', { name: 'Code name' }).fill(opts.codename);
      await dialog.getByRole('textbox', { name: 'Target name' }).fill(opts.target);
      await dialog.getByRole('combobox', { name: 'Starting step' }).selectOption({ label });
      await dialog.getByRole('textbox', { name: 'Conflicts approved by' }).fill(opts.approver);
      await dialog.getByRole('button', { name: 'Open mandate' }).click();
      await page.waitForURL(/\/projects\/[^/]+\/rail\?new=1/);
      const code = decodeURIComponent(new URL(page.url()).pathname.split('/')[2]);
      ctx.state.dealCode = code;
      ctx.state.dealCodename = opts.codename;
      ctx.state.promotedDeals = { ...ctx.state.promotedDeals, [opts.candidate]: code };
    },

    async assertUi(ctx) {
      const { page } = ctx;
      const receipt = page.getByRole('status', { name: 'Mandate opened' });
      await expect(receipt).toContainText('Mandate opened from discovery');
      await expect(receipt).toContainText('MNPI screen: Compliant');
      // Zoomed into the current step, the zoom-out control names its phase:
      // a position exists, in a named phase.
      const detail = await zoomIntoCurrentStep(page);
      await expect(detail.getByRole('button', { name: ZOOM_OUT })).toBeVisible();
    },

    async verify(ctx) {
      const ref = ctx.state.dealCode as string;
      const { deal } = await ctx.evidence.getDeal(ref);
      expect(deal.codename).toBe(opts.codename);
      expect(deal.entry_step_seq, 'the deal enters at the chosen step').toBe(opts.seq);
      expect(deal.current_step_seq ?? deal.entry_step_seq).toBe(opts.seq);
      ctx.state.stepSeqBefore = opts.seq;

      const me = await ctx.evidence.me();
      await ctx.evidence.expectAudit(ref, { action: 'discovery.candidate_promoted', actorId: me.user.id, since: ctx.since });

      const rows = await correctionsFor(candidateId(ctx, opts.candidate), 'promote');
      expect(rows, 'one promote correction on the candidate').toHaveLength(1);
      expect(rows[0].deal_id).toBe(deal.id);
    },
  };
}
