import { test, expect } from '../support/fixtures';
import type { Page, Locator } from '@playwright/test';
import { MEMBER_STATE_PATH, MEMBER_EMAIL } from '../auth/session';
import { createRailDeal, insertCustomStep } from '../support/railDealFixture';
import {
  answerRailEditPrompt,
  openPhase,
  openPhaseOf,
  openStepFromBoard,
  removeStepFromCard,
  zoomOutToBoard,
  stepLocator,
  zoomIntoCurrentStep,
} from '../support/rail';
import { MVP_DEAL_RAIL, RELATIONSHIP_PATHING_STEP_ID } from '@/lib/rail/dealRail';
import type { Evidence } from '../support/evidence';

async function memberUserId(evidence: Evidence): Promise<string> {
  const me = await evidence.me();
  const companyId = me.company?.id;
  expect(companyId, "the MD's own company id is required to resolve the member").toBeTruthy();
  const { members } = await evidence.listCompanyMembers(companyId!);
  const member = members.find((m) => m.email === MEMBER_EMAIL);
  expect(member, `no company member found at ${MEMBER_EMAIL}`).toBeTruthy();
  return member!.id;
}

/**
 * Verification of the project-owned deal rail
 * (docs/superpowers/specs/2026-09-09-project-rail-model-design.md).
 *
 * Every test creates its own deal through POST /api/v1/deals — the same
 * Gate 0 RPC the wizard drives — so each run is independent of whatever an
 * earlier run left behind. A fresh deal seeds the full MVP rail (61 steps)
 * with fully resolving titles, so it is a clean, predictable starting point.
 */

const RELATIONSHIP_PATHING_SEQ = 8;
const MVP_STEP_COUNT = 61;
const PROTECTED_MANUAL_STEP_ID = 'p1-s10';
const MANDATE_ACTIVATION_STEP_ID = 'p2-s26';
const KICKOFF_STEP_ID = 'p2-s28';
const TIMELINE_STEP_ID = 'p2-s29';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

function railOverview(page: Page): Locator {
  return page.getByRole('region', { name: 'Rail overview' });
}

/**
 * Open every phase on the board so every step card renders. Each phase is
 * opened by its own toggle: "N done" rows are collapsed buttons too, so "any
 * closed button" is not a phase. Every phase must end up open, so a missing
 * toggle fails here.
 */
async function openAllPhases(page: Page): Promise<void> {
  const overview = railOverview(page);
  await expect(overview).toBeVisible();
  for (const phase of MVP_DEAL_RAIL) {
    await openPhase(page, phase.name);
    await expect(
      overview.getByRole('button', { name: phase.name, exact: true }),
    ).toHaveAttribute('aria-expanded', 'true');
  }
}

function stepCard(page: Page, stepId: string, state?: string): Locator {
  return stepLocator(page, stepId, state).locator('..');
}

async function stepOrder(page: Page): Promise<(string | null)[]> {
  return railOverview(page)
    .locator('[data-step]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-step')));
}

test.describe('project rail model — MD', () => {
  test.beforeEach(async ({}, testInfo) => {
    test.skip(
      testInfo.project.name === 'live',
      'the custom-step fixture writes straight to a local database; a deployed environment owns its own rows',
    );
  });

  test('the rail renders from the server, ordered and grouped by phase', async ({ page, evidence, runId }) => {
    const deal = await createRailDeal(evidence.request, { runId });

    await page.goto(`/projects/${encodeURIComponent(deal.code)}/rail`);
    const overview = railOverview(page);
    await expect(overview).toBeVisible();
    await expect(overview.locator('[data-terminal="start"]')).toBeVisible();
    await expect(overview.locator('[data-terminal="end"]')).toBeVisible();
    await expect(overview.getByRole('button', { name: 'Origination, Qualification & Mandate' })).toBeVisible();
    await expect(overview.getByRole('button', { name: 'Preparation & Market Readiness' })).toBeVisible();
    await openAllPhases(page);
    await expect(overview.locator('[data-step]')).toHaveCount(MVP_STEP_COUNT);

    await expect(overview.getByText('Mandate Activation Checklist').first()).toBeVisible();
    await expect(overview.getByText('Win/Loss Debrief').first()).toBeVisible();
    await expect(overview.getByText('Kickoff / Org Meeting').first()).toBeVisible();

    const titles = await overview.getByRole('button').allInnerTexts();
    const relevant = titles.filter((t) =>
      /Mandate Activation Checklist|Win.Loss Debrief|Kickoff . Org Meeting/.test(t),
    );
    expect(relevant.join(' | ')).toMatch(
      /Mandate Activation Checklist[\s\S]*Win.Loss Debrief[\s\S]*Kickoff/,
    );
  });

  test('the board offers Remove only where it works; the zoomed step states why not', async ({
    page,
    evidence,
    runId,
  }) => {
    const deal = await createRailDeal(evidence.request, { runId });
    const complete = await evidence.request.patch(`/api/v1/deals/${deal.code}/steps/${TIMELINE_STEP_ID}`, {
      data: {
        work: { template_matched: true, baseline_milestones: 'QA baseline for e2e verification' },
        complete: true,
      },
    });
    expect(complete.ok(), await complete.text()).toBeTruthy();

    await page.goto(`/projects/${encodeURIComponent(deal.code)}/rail`);

    await test.step('a protected pending step offers no Remove on its card', async () => {
      await openPhaseOf(page, PROTECTED_MANUAL_STEP_ID);
      const card = stepCard(page, PROTECTED_MANUAL_STEP_ID, 'To do');
      await expect(card).toBeVisible();
      await expect(card.getByRole('button', { name: 'Remove', exact: true })).toHaveCount(0);
    });

    await test.step('a completed unprotected step offers no Remove on its card', async () => {
      await openPhaseOf(page, TIMELINE_STEP_ID);
      const card = stepCard(page, TIMELINE_STEP_ID, 'Done');
      await expect(card).toBeVisible();
      await expect(card.getByRole('button', { name: 'Remove', exact: true })).toHaveCount(0);
    });

    await test.step('clicking a card opens the step over the board, and the disabled Remove states its reason there', async () => {
      await openStepFromBoard(page, deal.code, PROTECTED_MANUAL_STEP_ID);
      await expect(page.getByRole('dialog', { name: 'Rail step' })).toBeVisible();
      const focus = page.getByRole('region', { name: 'Step detail' });
      await expect(focus.getByRole('button', { name: 'Remove', exact: true })).toBeDisabled();
      await expect(focus.getByText('This step is required and cannot be removed.')).toBeVisible();
    });
  });

  test('Remove sits in step detail, confirms there, and dismissing removes nothing', async ({
    page,
    evidence,
    runId,
  }) => {
    const deal = await createRailDeal(evidence.request, { runId });

    await page.goto(`/projects/${encodeURIComponent(deal.code)}/rail`);
    await openPhaseOf(page, MANDATE_ACTIVATION_STEP_ID);
    const card = stepCard(page, MANDATE_ACTIVATION_STEP_ID);
    await expect(card).toBeVisible();

    await test.step('the card carries no Remove button of its own', async () => {
      await expect(card.getByRole('button', { name: 'Remove', exact: true })).toHaveCount(0);
    });

    await test.step('Remove in step detail asks first and says what is kept', async () => {
      const panel = await removeStepFromCard(page, card, false);
      await expect(panel.getByText(/moves out of the active rail/)).toBeVisible();
      await expect(panel.getByRole('button', { name: 'Cancel' })).toBeVisible();
    });

    await test.step('dismissing does not remove the step, including after a reload', async () => {
      const panel = page.getByRole('region', { name: 'Step detail' });
      await panel.getByRole('button', { name: 'Cancel' }).click();
      await expect(panel.getByText(/moves out of the active rail/)).toHaveCount(0);

      await page.goto(`/projects/${encodeURIComponent(deal.code)}/rail`);
      await openPhaseOf(page, MANDATE_ACTIVATION_STEP_ID);
      await expect(stepCard(page, MANDATE_ACTIVATION_STEP_ID)).toBeVisible();
      await expect(page.locator('details', { hasText: 'Removed steps' })).toHaveCount(0);
    });
  });

  test('removing a step keeps its work, lists it by a human name, and restoring returns it to its place', async ({
    page,
    evidence,
    runId,
  }) => {
    const deal = await createRailDeal(evidence.request, { runId, entryStepSeq: RELATIONSHIP_PATHING_SEQ });
    const saved = await evidence.request.patch(`/api/v1/deals/${deal.code}/steps/${KICKOFF_STEP_ID}`, {
      data: { work: { note: 'qa-retained-work-marker' } },
    });
    expect(saved.ok(), await saved.text()).toBeTruthy();

    await page.goto(`/projects/${encodeURIComponent(deal.code)}/rail`);
    const overview = railOverview(page);
    await openAllPhases(page);
    await expect(overview.locator('[data-step]')).toHaveCount(MVP_STEP_COUNT);
    const orderBefore = await stepOrder(page);
    const removedSection = page.locator('details', { hasText: 'Removed steps' });

    await test.step('confirming removes the step from the active rail', async () => {
      const card = stepCard(page, KICKOFF_STEP_ID);
      await removeStepFromCard(page, card);
      await answerRailEditPrompt(page);
      await zoomOutToBoard(page);
      await expect(stepLocator(page, KICKOFF_STEP_ID)).toHaveCount(0, { timeout: 10_000 });
      await expect(overview.locator('[data-step]')).toHaveCount(MVP_STEP_COUNT - 1);
      await expect(overview.locator('[data-step][data-state="active"]')).toHaveCount(1);
    });

    await test.step('the removed step keeps its saved work', async () => {
      const { step } = await evidence.getStep(deal.code, KICKOFF_STEP_ID);
      expect(step.work).toMatchObject({ note: 'qa-retained-work-marker' });
    });

    await test.step('the removed step appears under Removed steps with a human name', async () => {
      await expect(removedSection).toBeVisible();
      await removedSection.locator('summary').click();
      const removedRow = removedSection.locator('li', { hasText: 'Kickoff / Org Meeting' });
      await expect(removedRow).toBeVisible();
      await expect(removedRow.getByText(/^Removed /)).toBeVisible();
      await expect(removedRow.getByText(/by Storm Duncan/)).toBeVisible();
      await expect(removedRow.getByText(new RegExp(`by ${UUID.source}`))).toHaveCount(0);
    });

    await test.step('restore returns the step to its original position with its work', async () => {
      await removedSection
        .locator('li', { hasText: 'Kickoff / Org Meeting' })
        .getByRole('button', { name: 'Restore' })
        .click();
      await expect(stepLocator(page, KICKOFF_STEP_ID)).toBeVisible({ timeout: 10_000 });
      await expect(overview.locator('[data-step]')).toHaveCount(MVP_STEP_COUNT);
      expect(await stepOrder(page)).toEqual(orderBefore);

      const { step } = await evidence.getStep(deal.code, KICKOFF_STEP_ID);
      expect(step.work).toMatchObject({ note: 'qa-retained-work-marker' });
    });
  });

  test('a skipped step stays on the active rail and survives reload with a human approver name', async ({
    page,
    evidence,
    runId,
  }) => {
    const deal = await createRailDeal(evidence.request, {
      runId,
      entryStepSeq: RELATIONSHIP_PATHING_SEQ,
    });

    await page.goto(`/projects/${encodeURIComponent(deal.code)}/rail`);
    const focus = await zoomIntoCurrentStep(page);
    await expect(focus.getByRole('heading', { name: /Relationship Pathing/ })).toBeVisible();

    await focus.getByRole('button', { name: 'Skip…' }).click();
    const modal = page.getByRole('dialog', { name: /Skip.*Relationship Pathing/ });
    await modal.getByLabel('Reason').fill('QA verification: this step does not apply.');
    await modal.getByRole('button', { name: 'Skip step' }).click();
    await expect(modal).toHaveCount(0);

    await page.goto(`/projects/${encodeURIComponent(deal.code)}/rail`);
    await openAllPhases(page);
    const card = stepCard(page, RELATIONSHIP_PATHING_STEP_ID, 'Skipped');
    await expect(card).toBeVisible();
    await expect(card.getByText(/Completed by: Storm Duncan/)).toBeVisible();
    await expect(card.getByText(UUID)).toHaveCount(0);
    await expect(railOverview(page).locator('[data-step][data-state="active"]')).toHaveCount(1);
  });

  test('there is no Add step affordance on a zoomed-in step', async ({ page, evidence, runId }) => {
    const deal = await createRailDeal(evidence.request, { runId });

    await page.goto(`/projects/${encodeURIComponent(deal.code)}/rail`);
    const focus = await zoomIntoCurrentStep(page);
    await expect(focus.getByRole('heading').first()).toBeVisible();
    await expect(page.getByRole('button', { name: /Add new step|Add a step/i })).toHaveCount(0);
  });

  test('a custom step with no catalog entry renders from its own definition (zoomed in)', async ({
    page,
    evidence,
    runId,
  }) => {
    const deal = await createRailDeal(evidence.request, { runId });
    await insertCustomStep(deal.id, {
      stepId: `custom-qa-${runId}`,
      title: 'QA Custom Step',
      description: 'A step added for exploratory verification, no catalog entry.',
      phaseIndex: 1,
      displayOrder: 0,
    });

    await page.goto(`/projects/${encodeURIComponent(deal.code)}/rail`);
    const focus = await zoomIntoCurrentStep(page);

    for (let i = 0; i < 5; i++) {
      const heading = focus.getByRole('heading', { name: 'QA Custom Step' });
      if (await heading.count()) break;
      const prev = focus.getByRole('button', { name: /Previous step/ });
      if ((await prev.count()) === 0) break;
      await prev.click();
    }
    await expect(focus.getByRole('heading', { name: 'QA Custom Step' })).toBeVisible();
    await expect(
      focus.getByText('A step added for exploratory verification, no catalog entry.'),
    ).toBeVisible();
  });
});

test.describe('project rail model — bank member without structure permission', () => {
  test.use({ storageState: MEMBER_STATE_PATH });

  test.beforeEach(async ({}, testInfo) => {
    test.skip(
      testInfo.project.name === 'live',
      'the bank-member identity is a local seed; a deployed environment owns its own accounts',
    );
  });

  test('the member has no Remove control on any step card or zoomed-in step', async ({ page, evidence, runId }) => {
    const deal = await createRailDeal(evidence.request, {
      runId,
      memberIds: [await memberUserId(evidence)],
    });

    await test.step('no step card on the board offers Remove', async () => {
      await page.goto(`/projects/${encodeURIComponent(deal.code)}/rail`);
      await openAllPhases(page);
      const overview = railOverview(page);
      await expect(overview.locator('[data-step]')).toHaveCount(MVP_STEP_COUNT);

      // Remove lives in step detail; the board carries no Remove and no plus for the member.
      await expect(overview.getByRole('button', { name: 'Remove', exact: true })).toHaveCount(0);
      await expect(overview.getByRole('button', { name: /^Add a step after / })).toHaveCount(0);
    });

    await test.step('the zoomed-in step offers no Remove either', async () => {
      await openStepFromBoard(page, deal.code, MANDATE_ACTIVATION_STEP_ID);
      const focus = page.getByRole('region', { name: 'Step detail' });
      await expect(focus.getByRole('button', { name: 'Remove', exact: true })).toHaveCount(0);
    });
  });

  test('the member has no Add step affordance, on the board or zoomed in', async ({
    page,
    evidence,
    runId,
  }) => {
    const deal = await createRailDeal(evidence.request, {
      runId,
      memberIds: [await memberUserId(evidence)],
    });

    await page.goto(`/projects/${encodeURIComponent(deal.code)}/rail`);
    await openPhaseOf(page, MANDATE_ACTIVATION_STEP_ID);
    await expect(railOverview(page).getByText('Mandate Activation Checklist').first()).toBeVisible();
    await expect(page.getByRole('button', { name: /Add new step|Add a step/i })).toHaveCount(0);
    const focus = await zoomIntoCurrentStep(page);
    await expect(focus.getByRole('heading').first()).toBeVisible();
    await expect(page.getByRole('button', { name: /Add new step|Add a step/i })).toHaveCount(0);
  });
});
