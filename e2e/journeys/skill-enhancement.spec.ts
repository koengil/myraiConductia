import { test, expect } from '../support/fixtures';
import type { Page } from '@playwright/test';
import { createRailDeal } from '../support/railDealFixture';
import { answerRailEditPrompt, chooseAddStepPosition, DRAFT_BUTTON, addedStepCard } from '../support/rail';

/**
 * Verification of skill enhancement and version selection
 * (docs/superpowers/specs/2026-09-14-skill-enhancement-and-version-selection-design.md).
 *
 * Live-tier only, by the E2E_BASE_URL skip below: every step calls a real
 * Ignatious skill bench. An initial skill is authored and published from
 * scratch, run, enhanced through a short exchange, published again, run
 * again, and the previous version is selected, run and finally promoted.
 *
 * The enhancement arm is instructed to interview before drafting, and the
 * model holds that line even when told not to, so reaching a candidate
 * there takes a follow-up rather than a single message.
 *
 * The hermetic tier cannot stand in for this. It points
 * IGNATIOUS_SKILL_BENCH_URL at the publication stub and blanks the rest
 * (playwright.config.ts), so publication is answerable there but authoring
 * turns and skill runs are not.
 */

const STEP_MESSAGE =
  'Propose a private skill now, no clarifying questions: it drafts a two ' +
  'sentence weekly memo summarising deal progress for the firm\'s internal ' +
  'board review, from the banker\'s own free-text input each week. Use ' +
  'reasonable defaults for anything unspecified and submit the proposal now.';
const ENHANCE_MESSAGE =
  'Also close by naming the single open decision the board must make next.';
const ENHANCE_FOLLOW_UP =
  'Use reasonable defaults for every open question: a distinct trailing ' +
  '"Decision:" line, and "No board decision needed this week" when there is ' +
  'none. Apply that and propose the updated skill.';
const RUN_INPUT_FIRST = 'Week 12: buyer outreach and management prep.';
const RUN_INPUT_SECOND = 'Week 13: first-round bids are in.';
const RUN_INPUT_THIRD = 'Week 14: exclusivity granted to the lead bidder.';

function railUrl(dealCode: string): string {
  return `/projects/${encodeURIComponent(dealCode)}/rail`;
}

async function focusRegion(page: Page) {
  const focus = page.getByRole('region', { name: 'Step detail' });
  await expect(focus).toBeVisible();
  return focus;
}

async function builderDialog(page: Page, name: 'Skill builder' | 'Enhance skill') {
  const dialog = page.getByRole('dialog', { name });
  await expect(dialog).toBeVisible();
  // The draft-open effect can fire twice on mount (Next dev fast refresh /
  // React double-invoke) and the second response overwrites local field
  // edits made before it resolves. Give both opens time to settle before
  // touching any field.
  await dialog.page().waitForTimeout(2000);
  return dialog;
}

async function waitForSaved(dialog: ReturnType<Page['getByRole']>) {
  await expect(dialog.getByTestId('draft-status')).not.toHaveText('Saving', { timeout: 15_000 });
}

async function sendOneMessage(dialog: ReturnType<Page['getByRole']>, message: string) {
  await dialog.getByLabel('Message').fill(message);
  await waitForSaved(dialog);
  await dialog.getByRole('button', { name: 'Send' }).click();
}

async function waitForCandidate(
  dialog: ReturnType<Page['getByRole']>,
  submitButton: ReturnType<Page['getByRole']>,
  maxRetries: number,
  followUp?: string,
  maxFollowUps = 0,
) {
  const retryButton = dialog.getByRole('button', { name: 'Retry' });
  const sendButton = dialog.getByRole('button', { name: 'Send' });
  const composer = dialog.getByLabel('Message');
  const deadline = Date.now() + 600_000;
  let retries = 0;
  let followUps = 0;
  while (Date.now() < deadline) {
    if (await submitButton.isEnabled()) return;
    if (await retryButton.isVisible().catch(() => false)) {
      if (retries >= maxRetries) throw new Error(`No candidate after ${retries} retries.`);
      retries += 1;
      await retryButton.click();
      await retryButton
        .waitFor({ state: 'hidden', timeout: 10_000 })
        .catch(() => undefined);
      continue;
    }
    if (followUp !== undefined && followUps < maxFollowUps) {
      if ((await composer.inputValue()) === '') await composer.fill(followUp);
      if (await sendButton.isEnabled().catch(() => false)) {
        followUps += 1;
        await sendButton.click();
        await dialog.page().waitForTimeout(3000);
        continue;
      }
    }
    await dialog.page().waitForTimeout(2000);
  }
  throw new Error('No candidate before deadline.');
}

test.describe('skill enhancement and version selection', () => {
  test('an MD authors, publishes, enhances and selects skill versions on a step', async ({
    page,
    evidence,
    runId,
  }) => {
    test.skip(!process.env.E2E_BASE_URL, 'Needs a real Ignatious skill bench; live tier only.');
    test.setTimeout(900_000);

    const stepName = `Weekly board memo ${runId}`;
    const deal = await createRailDeal(evidence.request, { runId });

    await page.goto(railUrl(deal.code));
    await page.getByRole('button', { name: 'Add new step' }).first().click();

    const buildDialog = await builderDialog(page, 'Skill builder');
    await buildDialog.getByLabel('Step name').fill(stepName);
    await waitForSaved(buildDialog);
    await chooseAddStepPosition(buildDialog, 'phase_start');
    await waitForSaved(buildDialog);
    await sendOneMessage(buildDialog, STEP_MESSAGE);

    const saveButton = buildDialog.getByRole('button', { name: 'Save skill and add step' });
    await waitForCandidate(buildDialog, saveButton, 8);
    await saveButton.click();
    await answerRailEditPrompt(page, 120_000);
    await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 120_000 });

    // The rail lands on the board with the new card highlighted; open it.
    const added = addedStepCard(page);
    await expect(added).toContainText(stepName);
    await added.getByRole('button', { name: /^Step \d+ · / }).click();
    const focus = await focusRegion(page);
    await expect(focus.getByRole('heading', { name: stepName })).toBeVisible();

    const runner = focus.getByRole('region', { name: 'Skill run' });
    await expect(runner).toBeVisible();
    const history = runner.getByRole('list', { name: 'Run history' });

    await runner.getByLabel('Additional instructions').fill(RUN_INPUT_FIRST);
    await runner.getByRole('button', { name: DRAFT_BUTTON }).click();
    await expect(history.getByRole('button', { name: /Improve this skill/ })).toHaveCount(1, {
      timeout: 120_000,
    });

    const versionSelect = runner.getByLabel('Skill version');
    const versionAfterFirstRun = await versionSelect.inputValue();

    await history.getByRole('button', { name: /Improve this skill/ }).first().click();
    const enhanceDialog = await builderDialog(page, 'Enhance skill');

    await sendOneMessage(enhanceDialog, ENHANCE_MESSAGE);

    const publishButton = enhanceDialog.getByRole('button', {
      name: 'Publish and use on this step',
    });
    await waitForCandidate(enhanceDialog, publishButton, 8, ENHANCE_FOLLOW_UP, 3);
    await publishButton.click();
    await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 120_000 });

    const focusAfterEnhance = await focusRegion(page);
    const runnerAfterEnhance = focusAfterEnhance.getByRole('region', { name: 'Skill run' });
    const versionSelectAfterEnhance = runnerAfterEnhance.getByLabel('Skill version');
    await expect
      .poll(() => versionSelectAfterEnhance.inputValue(), { timeout: 30_000 })
      .not.toBe(versionAfterFirstRun);
    const versionAfterEnhance = await versionSelectAfterEnhance.inputValue();

    const historyAfterEnhance = runnerAfterEnhance.getByRole('list', { name: 'Run history' });
    await runnerAfterEnhance.getByLabel('Additional instructions').fill(RUN_INPUT_SECOND);
    await runnerAfterEnhance.getByRole('button', { name: DRAFT_BUTTON }).click();
    await expect(historyAfterEnhance.getByRole('button', { name: /Improve this skill/ })).toHaveCount(
      2,
      { timeout: 120_000 },
    );

    const stepId = await findStepId(evidence, deal.id, stepName);
    const runsAfterSecond = await readSkillRunsOrdered(evidence, deal.id, stepId);
    expect(digestOf(runsAfterSecond[0])).toBe(versionDigestOf(versionAfterEnhance));
    expect(digestOf(runsAfterSecond[0])).not.toBe(versionDigestOf(versionAfterFirstRun));

    await versionSelectAfterEnhance.selectOption(versionAfterFirstRun);
    const useOnStepButton = runnerAfterEnhance.getByRole('button', { name: 'Use on this step' });
    await expect(useOnStepButton).toBeVisible();

    await runnerAfterEnhance.getByLabel('Additional instructions').fill(RUN_INPUT_THIRD);
    await runnerAfterEnhance.getByRole('button', { name: DRAFT_BUTTON }).click();
    await expect(historyAfterEnhance.getByRole('button', { name: /Improve this skill/ })).toHaveCount(
      3,
      { timeout: 120_000 },
    );

    const runsAfterThird = await readSkillRunsOrdered(evidence, deal.id, stepId);
    expect(digestOf(runsAfterThird[0])).toBe(versionDigestOf(versionAfterFirstRun));

    const versionsResponse = await evidence.request.get(
      `/api/v1/deals/${encodeURIComponent(deal.id)}/steps/${encodeURIComponent(stepId)}/skill-versions`,
    );
    expect(versionsResponse.ok()).toBeTruthy();
    const versionsBody = (await versionsResponse.json()) as {
      current: { versionId?: string; digest: string } | null;
    };
    expect(versionsBody.current?.digest).toBe(versionDigestOf(versionAfterEnhance));

    await useOnStepButton.click();
    await expect
      .poll(() => versionSelectAfterEnhance.inputValue(), { timeout: 30_000 })
      .toBe(versionAfterFirstRun);
  });
});

function versionDigestOf(referenceKey: string): string {
  const parts = referenceKey.split(':');
  return parts[parts.length - 1];
}

type SkillRunRow = {
  id: string;
  outcome: string;
  input: string;
  binding: { digest: string } | null;
};

async function findStepId(
  evidence: { request: import('@playwright/test').APIRequestContext },
  dealId: string,
  stepTitle: string,
): Promise<string> {
  const response = await evidence.request.get(`/api/v1/deals/${encodeURIComponent(dealId)}/rail`);
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as {
    steps: { stepId: string; definition?: { title?: string } | null }[];
  };
  const step = body.steps.find((candidate) => candidate.definition?.title === stepTitle);
  if (!step) throw new Error(`could not find step ${stepTitle} on the rail`);
  return step.stepId;
}

async function readSkillRunsOrdered(
  evidence: { request: import('@playwright/test').APIRequestContext },
  dealId: string,
  stepId: string,
): Promise<SkillRunRow[]> {
  const runsResponse = await evidence.request.get(
    `/api/v1/deals/${encodeURIComponent(dealId)}/steps/${encodeURIComponent(stepId)}/skill-runs`,
  );
  expect(runsResponse.ok()).toBeTruthy();
  const runsBody = (await runsResponse.json()) as { runs: SkillRunRow[] };
  return runsBody.runs;
}

function digestOf(run: SkillRunRow): string | null {
  return run.binding?.digest ?? null;
}
