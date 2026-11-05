import { expect } from '@playwright/test';
import { correctionAudit, correctionsFor } from '../support/discoveryEvidence';
import { candidateId } from './openCandidate';
import type { Step } from './types';

/** Beat 4a: Storm merges Harbor into Kestrel. The merge is a logged correction with a reason. */
export function mergeCandidates(opts: { merged: string; survivor: string; reason: string }): Step {
  return {
    name: `mergeCandidates · ${opts.merged} into ${opts.survivor}`,

    async act(ctx) {
      const { page } = ctx;
      await page.goto(`/discovery/${candidateId(ctx, opts.merged)}`);
      await page.getByRole('button', { name: 'Merge into…' }).click();
      const dialog = page.getByRole('dialog', { name: `Merge ${opts.merged} into another deal` });
      await dialog.getByRole('combobox', { name: 'Merge into' }).selectOption({ label: opts.survivor });
      await dialog.getByRole('textbox', { name: 'Reason' }).fill(opts.reason);
      await dialog.getByRole('button', { name: 'Merge', exact: true }).click();
    },

    async assertUi(ctx) {
      const { page } = ctx;
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.getByRole('status').filter({ hasText: `Merged into ${opts.survivor}` })).toBeVisible();
      const history = page.getByRole('region', { name: 'Decision history' });
      await expect(history).toContainText(`merged this proposed deal into ${opts.survivor}`);
      await expect(history).toContainText(`Reason: ${opts.reason}.`);
    },

    async verify(ctx) {
      const merged = candidateId(ctx, opts.merged);
      const survivor = candidateId(ctx, opts.survivor);
      const rows = await correctionsFor(merged, 'merge');
      expect(rows, 'one merge correction on the merged deal').toHaveLength(1);
      expect(rows[0].reason).toBe(opts.reason);
      const audit = await correctionAudit(merged, 'merge', ctx.since);
      expect(audit, 'one discovery.correction audit row for the merge').toHaveLength(1);
      expect((audit[0].detail as { survivorId?: string }).survivorId).toBe(survivor);

      const list = await ctx.evidence.request.get('/api/v1/discovery/candidates');
      const names = ((await list.json()) as { candidates: Array<{ name: string }> }).candidates.map((c) => c.name);
      expect(names, 'the merged deal leaves the list').not.toContain(opts.merged);
    },
  };
}
