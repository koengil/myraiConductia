import { expect } from '@playwright/test';
import { correctionAudit, correctionsFor } from '../support/discoveryEvidence';
import { candidateId } from './openCandidate';
import type { Step } from './types';

/**
 * Beat 4b: Storm sets Kestrel's step himself. The evidence's own suggestion
 * stays beneath his, and the change is a history row with its reason and a
 * discovery.correction audit row.
 */
export function setStation(opts: { candidate: string; station: number; title: string; reason: string }): Step {
  const label = `${String(opts.station).padStart(2, '0')} · ${opts.title}`;
  return {
    name: `setStation · ${opts.candidate} to ${label}`,

    async act(ctx) {
      const { page } = ctx;
      await page.goto(`/discovery/${candidateId(ctx, opts.candidate)}`);
      await page.getByRole('button', { name: 'Set step' }).click();
      const dialog = page.getByRole('dialog', { name: 'Set the step' });
      await dialog.getByRole('combobox', { name: 'Step' }).selectOption({ label });
      await dialog.getByRole('textbox', { name: 'Reason' }).fill(opts.reason);
      await dialog.getByRole('button', { name: 'Set step', exact: true }).click();
    },

    async assertUi(ctx) {
      const { page } = ctx;
      await expect(page.getByRole('dialog')).toHaveCount(0);
      const station = page.getByRole('region', { name: 'Suggested step' });
      await expect(station).toContainText('Step set by a person');
      await expect(station).toContainText(`Step ${String(opts.station).padStart(2, '0')} · ${opts.title}`);
      await expect(station).toContainText(opts.reason);
      const history = page.getByRole('region', { name: 'Decision history' });
      await expect(history).toContainText(`set the step to ${opts.station} · ${opts.title}`);
      await expect(history).toContainText(`Reason: ${opts.reason}.`);
    },

    async verify(ctx) {
      const id = candidateId(ctx, opts.candidate);
      const rows = await correctionsFor(id, 'set_station');
      expect(rows, 'one set_station correction').toHaveLength(1);
      expect(rows[0].reason).toBe(opts.reason);
      const me = await ctx.evidence.me();
      expect(rows[0].actor_id).toBe(me.user.id);
      const audit = await correctionAudit(id, 'set_station', ctx.since);
      expect(audit, 'one discovery.correction audit row for the step').toHaveLength(1);
    },
  };
}
