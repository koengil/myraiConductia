import { expect } from '@playwright/test';
import { stepBySeq } from '@/lib/rail/dealRail';
import { ZOOM_OUT, zoomIntoCurrentStep } from '../support/rail';
import { escapeRegExp } from '../support/regexp';
import { expectSingleComplianceInstrument } from '../support/selectors';
import type { Step } from './types';

/**
 * Step 3 — the deal rail: the canonical sell-side lifecycle as phases and
 * steps, with the cursor on the entry step Gate 0 chose. `/deal-folder` is the
 * fixture explorer over the internal manifest; the surface backed by /steps and
 * the persisted rail position is /rail.
 */
export const openRail: Step = {
  name: 'openRail',

  async act(ctx) {
    await ctx.page.goto(`/projects/${encodeURIComponent(ctx.state.dealCode as string)}/rail`);
  },

  async assertUi(ctx) {
    // Zoomed into the current step, the zoom-out control names its phase.
    const detail = await zoomIntoCurrentStep(ctx.page);
    await expect(detail.getByRole('button', { name: ZOOM_OUT })).toBeVisible();
  },

  async verify(ctx) {
    const ref = ctx.state.dealCode as string;

    // The returned list is not used past this assertion (the seq-to-title
    // translation below reads from stepBySeq instead) — this call is still
    // load-bearing: hitting GET /api/v1/deals/{ref}/steps triggers
    // seedDataroomsForDeal on first access, which uploadToDataRoom later
    // depends on. Do not delete it.
    const { steps } = await ctx.evidence.listSteps(ref);
    expect(steps.length, 'the deal has no rail steps').toBeGreaterThan(0);

    const { deal } = await ctx.evidence.getDeal(ref);
    const seq = deal.current_step_seq ?? deal.entry_step_seq;
    expect(seq, 'the deal has no rail position').toBeTruthy();
    ctx.state.stepSeqBefore = seq as number;

    // `DealRail` derives `progress.done` from the cursor's INDEX in the MVP
    // rail subset (61 steps), not the canonical 1..65 `seq` the server
    // persists — so "N of M" never literally contains `seq`, by a variable
    // amount, not a fixed offset (confirmed live: seq 8 renders as "3 of
    // 61"). The `/steps` evidence endpoint is also no substitute: it is
    // scoped to the handful of dataroom-linked steps (Box datarooms), and the
    // entry step (Relationship Pathing, seq 8) is not one of them, so no
    // `/api/v1` response ever carries its title.
    //
    // The only source that maps a canonical seq to a step title is the rail
    // census both the server (Gate0 RPC numbering) and the client (DealRail)
    // already share as their one source of truth (the same pattern the
    // composite-scoring fixtures use: compare against the deterministic
    // function, not a hardcoded string). Anchored on the seq the server
    // returned via /api/v1, translate it with that shared census and assert
    // the browser actually renders that title — the same claim ("the
    // displayed position matches the server"), against a stable identifier.
    const expectedStep = stepBySeq(seq as number);
    expect(expectedStep, `no rail step is defined at seq ${seq}`).toBeTruthy();

    await expect(
      ctx.page
        .getByRole('region', { name: 'Step detail' })
        .getByRole('heading', { name: new RegExp(escapeRegExp(expectedStep!.title)) }),
    ).toBeVisible();

    await expectSingleComplianceInstrument(ctx.page);
  },
};
