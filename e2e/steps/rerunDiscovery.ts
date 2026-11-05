import { expect } from '@playwright/test';
import { candidateState, correctionsFor, liveLinkSubjects, rewindSources } from '../support/discoveryEvidence';
import { extractDemoMail, seedDemoMail } from '../support/discoveryProcess';
import { assertSeededMailPath } from '../support/mailPath';
import { candidateId } from './openCandidate';
import type { Step } from './types';

/**
 * Between the corrections and the promotion: discovery runs again over the same
 * mail, as the runbook does it (seed-discovery --corpus demo, then
 * worker/extract --once --strict), from a full re-read of every mailbox. Every
 * correction must still stand: the survivor keeps Harbor's emails without
 * duplicates, Kestrel keeps its name and Storm's step, Harbor stays merged,
 * and the decision history gains nothing. Assertions use titles and dates,
 * never email counts.
 */
export function rerunDiscovery(opts: {
  survivor: string;
  merged: string;
  /** The merged deal's email subjects, which the survivor must still hold. */
  mergedSubjects: string[];
  overrideStepId: string;
  station: number;
  title: string;
  reason: string;
  /** A date-bearing phrase of the evidence's own reason. Never the email count: it comes from the model's output. */
  reasonIncludes: string;
}): Step {
  let linksBefore: string[] = [];
  const nn = String(opts.station).padStart(2, '0');
  return {
    name: `rerunDiscovery · ${opts.survivor} keeps every correction`,

    async act(ctx) {
      linksBefore = await liveLinkSubjects(candidateId(ctx, opts.survivor));
      for (const subject of opts.mergedSubjects) expect(linksBefore, 'the merge gave the survivor the emails').toContain(subject);
      await rewindSources();
      seedDemoMail('rerunDiscovery');
      extractDemoMail('rerunDiscovery');
    },

    async assertUi(ctx) {
      const { page } = ctx;
      await page.goto('/discovery');
      await expect(page.getByRole('heading', { name: opts.survivor, exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: opts.merged, exact: true })).toHaveCount(0);

      await page.goto(`/discovery/${candidateId(ctx, opts.survivor)}`);
      await expect(page.getByRole('heading', { level: 1, name: opts.survivor })).toBeVisible();
      const station = page.getByRole('region', { name: 'Suggested step' });
      await expect(station).toContainText('Step set by a person');
      await expect(station).toContainText(`Step ${nn} · ${opts.title}`);
      await expect(station).toContainText(opts.reason);
      const history = page.getByRole('region', { name: 'Decision history' });
      await expect(history).toContainText(`merged ${opts.merged} into this proposed deal`);
      await expect(history).toContainText(`set the step to ${opts.station} · ${opts.title}`);
      await expect(history.getByRole('listitem')).toHaveCount(2);

      // The merged deal's page still reads as merged, and still points at the survivor.
      await page.goto(`/discovery/${candidateId(ctx, opts.merged)}`);
      await expect(page.getByRole('status').filter({ hasText: `Merged into ${opts.survivor}` })).toBeVisible();
    },

    async verify(ctx) {
      const survivor = candidateId(ctx, opts.survivor);
      const merged = candidateId(ctx, opts.merged);

      const linksAfter = await liveLinkSubjects(survivor);
      expect(linksAfter, 'the re-run neither dropped nor duplicated the survivor\'s emails').toEqual(linksBefore);
      for (const subject of opts.mergedSubjects) expect(linksAfter).toContain(subject);

      const kestrel = await candidateState(survivor);
      expect(kestrel.proposed_name, 'a re-run never renames the survivor').toBe(opts.survivor);
      expect(kestrel.station_override_step_id, 'a re-run keeps the MD\'s step').toBe(opts.overrideStepId);
      const harbor = await candidateState(merged);
      expect(harbor).toMatchObject({ discovery_state: 'merged_into', merged_into_id: survivor });

      expect(await correctionsFor(merged, 'merge'), 'the merge is logged once').toHaveLength(1);
      const stationRows = await correctionsFor(survivor, 'set_station');
      expect(stationRows, 'the step is logged once').toHaveLength(1);
      expect(stationRows[0].reason).toBe(opts.reason);

      const res = await ctx.evidence.request.get(`/api/v1/discovery/candidates/${survivor}`);
      expect(res.status()).toBe(200);
      const { candidate } = (await res.json()) as {
        candidate: { override: { title: string } | null; station: { title: string; reason: string } | null };
      };
      expect(candidate.override?.title).toBe(opts.title);
      // The evidence's own suggestion is still there beneath Storm's, with its dated reason.
      expect(candidate.station?.title).toBe(opts.title);
      expect(candidate.station?.reason).toContain(opts.reasonIncludes);

      // The mid-journey re-seed stayed on the project's mail path.
      await assertSeededMailPath();
    },
  };
}
