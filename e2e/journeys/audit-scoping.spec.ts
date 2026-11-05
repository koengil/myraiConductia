import { expect, test } from '../support/fixtures';
import { registerLead } from '../steps/registerLead';
import { createDeal } from '../steps/createDeal';
import { openRail } from '../steps/openRail';
import { advanceRail } from '../steps/advanceRail';
import { switchDeal } from '../steps/switchDeal';
import { readAuditTrail } from '../steps/readAuditTrail';
import { insertDealWithoutActivity } from '../support/railDealFixture';
import type { JourneyContext, Step } from '../steps/types';

test('a deal audit trail shows only its own events', async ({ page, evidence, runId, since }) => {
  // Two deals in one browser session, distinguishable by activity: the first
  // is walked onto the rail and advanced, the second is only opened.
  const first: JourneyContext = { page, evidence, runId: `${runId}a`, since, state: {} };
  const second: JourneyContext = { page, evidence, runId: `${runId}b`, since, state: {} };

  const plan: Array<{ label: string; step: Step; ctx: JourneyContext }> = [
    { label: 'deal A', step: registerLead, ctx: first },
    { label: 'deal A', step: createDeal, ctx: first },
    { label: 'deal A', step: openRail, ctx: first },
    { label: 'deal A', step: advanceRail, ctx: first },
    { label: 'deal B', step: registerLead, ctx: second },
    { label: 'deal B', step: createDeal, ctx: second },
    { label: 'deal A', step: switchDeal, ctx: first },
    { label: 'deal A', step: readAuditTrail, ctx: first },
    { label: 'deal B', step: switchDeal, ctx: second },
    { label: 'deal B', step: readAuditTrail, ctx: second },
  ];

  for (const { label, step, ctx } of plan) {
    await test.step(`${label} · ${step.name} · act`, () => step.act(ctx));
    await test.step(`${label} · ${step.name} · assertUi`, () => step.assertUi(ctx));
    await test.step(`${label} · ${step.name} · verify`, () => step.verify(ctx));
  }

  const codenameA = first.state.dealCodename as string;
  const codenameB = second.state.dealCodename as string;
  expect(codenameA).not.toBe(codenameB);

  const rowsA = first.state.auditRowTexts ?? [];
  const rowsB = second.state.auditRowTexts ?? [];
  expect(rowsA.length, "deal A's trail rendered no rows").toBeGreaterThan(0);
  expect(rowsB.length, "deal B's trail rendered no rows").toBeGreaterThan(0);
  expect(
    rowsB.filter((text) => text.includes(codenameA)),
    "deal A's codename appears in deal B's trail",
  ).toEqual([]);
  expect(
    rowsA.filter((text) => text.includes(codenameB)),
    "deal B's codename appears in deal A's trail",
  ).toEqual([]);

  const idsA = new Set(first.state.auditEventIds ?? []);
  const shared = (second.state.auditEventIds ?? []).filter((id) => idsA.has(id));
  expect(shared, 'the two trails share durable audit rows').toEqual([]);

  expect(
    (first.state.auditEventIds ?? []).length,
    'the deals had different activity but their durable trails are the same size',
  ).not.toBe((second.state.auditEventIds ?? []).length);
  expect(
    first.state.auditVisibleCount,
    'the deals had different activity but the register counts the same',
  ).not.toBe(second.state.auditVisibleCount);
});

// The empty register ("No activity yet. Actions you take across the deal are
// recorded here.") is unreachable for any deal the MD creates: Gate 0 writes
// the 'create' audit row before the trail can be opened, so a freshly created
// deal always has at least one event.
test('a deal with no activity shows the empty audit register', async ({ page, evidence, runId }, testInfo) => {
  test.skip(
    testInfo.project.name === 'live',
    'the deal is seeded with the local service key; a deployed environment has none',
  );

  const me = await evidence.me();
  const deal = await insertDealWithoutActivity(me.user.id, runId);

  await page.goto(`/projects/${encodeURIComponent(deal.code)}/audit`);
  await expect(page.getByRole('heading', { level: 1, name: 'Audit Trail' })).toBeVisible();
  await expect(
    page.getByText('No activity yet. Actions you take across the deal are recorded here.'),
  ).toBeVisible();

  const { events } = await evidence.listAudit(deal.code);
  expect(events).toEqual([]);
});
