import { expect } from '@playwright/test';
import { expectSingleComplianceInstrument } from '../support/selectors';
import type { Step } from './types';

const CREATE_ROW = 'Created the mandate';

export const readAuditTrail: Step = {
  name: 'readAuditTrail',

  async act(ctx) {
    await ctx.page
      .getByRole('navigation', { name: 'Primary navigation' })
      .getByRole('link', { name: 'Audit Trail' })
      .click();
    await ctx.page.waitForURL(/\/projects\/[^/]+\/audit/);
  },

  async assertUi(ctx) {
    const codename = ctx.state.dealCodename as string;

    await expect(
      ctx.page.getByRole('heading', { level: 1, name: 'Audit Trail' }),
    ).toBeVisible();
    await expect(
      ctx.page
        .getByRole('banner')
        .getByRole('button', { name: `Deal: ${codename}. Switch deal` }),
    ).toBeVisible();
    await expect(
      ctx.page.getByRole('group', { name: 'Filter audit events' }).getByRole('button', { name: 'All' }),
    ).toHaveAttribute('aria-pressed', 'true');

    const register = ctx.page.getByRole('region', { name: 'Audit Trail' });
    // The platform rows arrive from a fetch; waiting for the mandate's own
    // create row is what makes the counts below stable rather than racy.
    await expect(register.getByText(CREATE_ROW)).toBeVisible();

    const rows = register.getByRole('listitem');
    const rowCount = await rows.count();
    expect(rowCount, 'the audit trail rendered no rows').toBeGreaterThan(0);

    // A deal-scoped trail carries no per-row deal chip; it belongs to the
    // cross-deal view only.
    await expect(register.getByTestId('audit-row-deal')).toHaveCount(0);
    ctx.state.auditRowTexts = (await rows.allTextContents()).map((text) => text.trim());

    await expect(ctx.page.getByTestId('audit-event-count')).toHaveText(
      `${rowCount} ${rowCount === 1 ? 'event' : 'events'}`,
    );

    ctx.state.auditVisibleCount = rowCount;
  },

  async verify(ctx) {
    const ref = ctx.state.dealCode as string;
    const { deal, events } = await ctx.evidence.listAudit(ref);

    expect(deal.code).toBe(ref);
    expect(deal.codename).toBe(ctx.state.dealCodename as string);
    expect(events.length, 'the deal has no durable audit trail').toBeGreaterThan(0);
    for (const event of events) {
      expect(
        event.ts >= ctx.since,
        `an audit row on ${ref} predates this run: ${event.action}@${event.ts}`,
      ).toBe(true);
    }
    ctx.state.auditEventIds = events.map((event) => event.id);

    const me = await ctx.evidence.me();
    const created = await ctx.evidence.expectAudit(ref, {
      action: 'create',
      actorId: me.user.id,
      since: ctx.since,
    });
    const actorName = created.actor?.display_name || created.actor?.full_name;
    expect(actorName, 'the platform create row names no actor').toBeTruthy();
    // The create row's actor is the signed-in MD (expectAudit checked actorId),
    // so the register shows it as "You"; the export keeps the name.

    await expect(
      ctx.page
        .getByRole('region', { name: 'Audit Trail' })
        .getByRole('listitem')
        .filter({ hasText: CREATE_ROW })
        .getByTestId('audit-row-person'),
    ).toHaveText('You');

    expect(
      ctx.state.auditVisibleCount as number,
      'the register shows fewer rows than the durable trail carries',
    ).toBeGreaterThanOrEqual(events.length);

    await expectSingleComplianceInstrument(ctx.page);
  },
};
