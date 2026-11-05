import { expect } from '@playwright/test';
import { expectSingleComplianceInstrument } from '../support/selectors';
import type { Step } from './types';

export const TARGET_CLOSE = '2026-11-20';
export const TARGET_CLOSE_SHOWN = 'Nov 20, 2026';
export const FEE = '5100000';
export const FEE_SHOWN = '$5.1M';
export const SCHEDULE = 'Late';
export const CATEGORY = 'Mandate hold';

/**
 * Step 4 — the deal MD sets all four graduated Book fields. Each editor's
 * Save is disabled until its value actually changes, so the sequence proves
 * the guard as well as the write: assert disabled, change, assert enabled,
 * save. The receipts accumulate ("Saved." once per saved field), which is how
 * each save is attributed without pinning a structural selector.
 */
export const setBookFields: Step = {
  name: 'setBookFields',

  async act(ctx) {
    const page = ctx.page;
    await page.goto(`/projects/${ctx.state.dealCode}/book`);

    const saved = page.getByText('Saved.');
    const fields: Array<{ save: string; set: () => Promise<void> }> = [
      {
        save: 'Save target close',
        set: () => page.getByLabel('Target close date', { exact: true }).fill(TARGET_CLOSE),
      },
      { save: 'Save fee', set: () => page.getByLabel('Fee in US dollars', { exact: true }).fill(FEE) },
      {
        save: 'Save schedule status',
        set: async () => {
          await page.getByLabel('Schedule status', { exact: true }).selectOption({ label: SCHEDULE });
        },
      },
      {
        save: 'Save lifecycle category',
        set: async () => {
          await page.getByLabel('Lifecycle category', { exact: true }).selectOption({ label: CATEGORY });
        },
      },
    ];

    for (const [index, field] of fields.entries()) {
      const save = page.getByRole('button', { name: field.save });
      await expect(save, `${field.save} is enabled before the value changed`).toBeDisabled();
      await field.set();
      await expect(save).toBeEnabled();
      await save.click();
      await expect(saved).toHaveCount(index + 1);
    }
  },

  async assertUi(ctx) {
    const page = ctx.page;
    await expect(page.getByText(`Target close: ${TARGET_CLOSE_SHOWN}`)).toBeVisible();
    await expect(page.getByText(`Fee: ${FEE_SHOWN}`)).toBeVisible();
    await expect(page.getByText(`Schedule: ${SCHEDULE}`)).toBeVisible();
    await expect(page.getByText(`Category: ${CATEGORY}`)).toBeVisible();

    // The saved value came back from the server and re-armed every guard.
    for (const save of [
      'Save target close',
      'Save fee',
      'Save schedule status',
      'Save lifecycle category',
    ]) {
      await expect(page.getByRole('button', { name: save })).toBeDisabled();
    }
  },

  async verify(ctx) {
    const ref = ctx.state.dealCode as string;
    const { deal } = await ctx.evidence.getDeal(ref);
    expect(deal.targetCloseDate).toBe(TARGET_CLOSE);
    expect(deal.feeUsd).toBe(Number(FEE));
    expect(deal.scheduleStatus).toBe('late');
    expect(deal.lifecycleCategory).toBe('mandate_hold');

    const me = await ctx.evidence.me();
    const { events } = await ctx.evidence.listAudit(ref);
    const fields = events
      .filter((event) => event.action === 'update' && event.ts >= ctx.since)
      .filter((event) => event.actor?.id === me.user.id)
      .map((event) => (event.detail as { field?: string } | null)?.field);
    for (const column of [
      'target_close_date',
      'fee_usd',
      'schedule_status',
      'lifecycle_category',
    ]) {
      expect(fields, `no audited update of ${column}`).toContain(column);
    }

    await expectSingleComplianceInstrument(ctx.page);
  },
};
