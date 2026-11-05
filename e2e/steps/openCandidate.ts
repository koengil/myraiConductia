import { expect } from '@playwright/test';
import { annotatePendingRecording } from '../support/recording';
import type { Step } from './types';

export type OpenCandidateExpect = {
  /** The suggested-step line, for example "Diligence · Step 44 · LOI Review". */
  station: string;
  /** A date-bearing phrase in the templated reason. Never the email count: that comes from the model's output. */
  reasonIncludes?: string;
  /** The viewer's own mail shows the cited sentence with the cited span marked. */
  ownExcerpt?: boolean;
  /** A colleague-only item is listed as metadata only (Falcon today; Kestrel once beat 5 confirms Alex's reply). */
  colleagueRow?: boolean;
  closed?: boolean;
  /** The beat asserts an extracted step, so it is pending T2's recording while only the stub exists. */
  beat: string;
};

export function candidateId(ctx: Parameters<Step['act']>[0], name: string): string {
  const id = ctx.state.candidateIds?.[name];
  if (!id) throw new Error(`the journey has no candidate id for ${name}: openDiscovery must run first`);
  return id;
}

/** Beats 2 and 3: open one proposed deal and read its step, reason and evidence. */
export function openCandidate(name: string, expected: OpenCandidateExpect): Step {
  return {
    name: `openCandidate · ${name}`,

    async act(ctx) {
      await ctx.page.goto(`/discovery/${candidateId(ctx, name)}`);
    },

    async assertUi(ctx) {
      const { page } = ctx;
      annotatePendingRecording(expected.beat);
      await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
      const station = page.getByRole('region', { name: 'Suggested step' });
      await expect(station).toContainText(expected.station);
      if (expected.reasonIncludes) await expect(station).toContainText(expected.reasonIncludes);
      if (expected.closed) await expect(station.getByText('Closed', { exact: true })).toBeVisible();
      await expect(page.getByRole('region', { name: 'Milestones' })).toBeVisible();
      const evidence = page.getByRole('region', { name: 'Evidence' });
      if (expected.ownExcerpt) {
        await expect(evidence.locator('blockquote mark').first()).toBeVisible();
      }
      if (expected.colleagueRow) {
        await expect(evidence.getByText("From another banker's mailbox · metadata only").first()).toBeVisible();
      }
    },

    async verify(ctx) {
      const res = await ctx.evidence.request.get(`/api/v1/discovery/candidates/${candidateId(ctx, name)}`);
      expect(res.status(), `GET candidate ${name}`).toBe(200);
      const { candidate } = (await res.json()) as {
        candidate: { station: { title: string; lifecycle: string | null } | null; canAct: { ok: boolean } };
      };
      const title = expected.station.split(' · ').pop();
      expect(candidate.station?.title, `${name}: the API's suggested step`).toBe(title);
      if (expected.closed) expect(candidate.station?.lifecycle).toBe('closed');
    },
  };
}
