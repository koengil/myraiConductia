import { test, expect } from '../support/fixtures';
import type { Locator, Page } from '@playwright/test';
import { createRailDeal } from '../support/railDealFixture';
import { answerRailEditPrompt, removeStepFromCard, chooseAddStepPosition, addedStepCard, zoomOutToBoard } from '../support/rail';

const SAVE_BUTTON = 'Save skill and add step';
const CANDIDATE_READY = 'Ready to save';
const AUTHORING_PROMPT =
  'Draft this skill now and do not ask any clarifying questions; every decision is specified here. ' +
  'Purpose: review a data room index and list which diligence documents are missing. ' +
  'Input: a data room folder listing plus the buyer request list, pasted as text. ' +
  'Output: a flat list of missing documents grouped by the index own top-level folders, no owners and no due dates. ' +
  'Scope: presence check only; do not judge whether a document that is present is complete. ' +
  'Name it Data Room Gap Review. Propose the skill candidate now.';
const AUTHORING_FOLLOW_UP = 'All decisions stand as stated. Propose the candidate now.';

function fullArray(page: Page): Locator {
  return page.getByRole('region', { name: 'Rail overview' });
}

function stepCard(page: Page, title: string): Locator {
  return page.locator('[data-step]').filter({ hasText: title });
}


async function awaitTurn(dialog: Locator): Promise<void> {
  const generating = dialog.getByText('Generating');
  await generating.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => undefined);
  await generating.waitFor({ state: 'hidden', timeout: 300_000 });
}

async function retryWhileAttemptFailed(dialog: Locator, maxRetries = 2): Promise<void> {
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    const retry = dialog.getByRole('button', { name: 'Retry' });
    if ((await retry.count()) === 0) return;
    await retry.first().click();
    await awaitTurn(dialog);
  }
}

async function sendAuthoringMessage(dialog: Locator, text: string): Promise<void> {
  const composer = dialog.getByLabel('Message');
  await composer.click();
  await composer.pressSequentially(text, { delay: 8 });
  await expect(composer).toHaveValue(text, { timeout: 20_000 });
  const send = dialog.getByRole('button', { name: 'Send' });
  await expect(send).toBeEnabled({ timeout: 30_000 });
  await send.click();
  await awaitTurn(dialog);
  await retryWhileAttemptFailed(dialog);
}

test.describe('full journey against live Ignatious: rail, authoring, publication, removal', () => {
  test.skip(!process.env.E2E_BASE_URL, 'live tier only: needs a running app and skill bench');
  test.setTimeout(420_000);

  test('an MD builds a skill with Ignatious, publishes it onto the rail, then removes it', async ({
    page,
    evidence,
    runId,
  }) => {
    const deal = await createRailDeal(evidence.request, { runId });
    const stepName = `Data Room Gap Review ${runId}`;

    await test.step('Part A: the rail renders from the server', async () => {
      await page.goto(`/projects/${encodeURIComponent(deal.code)}/rail`);
      await expect(fullArray(page)).toBeVisible();
      await expect(fullArray(page).getByText('Mandate Activation Checklist')).toBeVisible();
      await expect(fullArray(page).getByText('Kickoff / Org Meeting')).toBeVisible();
    });

    const dialog = page.getByRole('dialog', { name: 'Skill builder' });

    await test.step('Part B: a live Ignatious turn produces a skill candidate', async () => {
      await page.getByRole('button', { name: 'Add new step' }).first().click();
      await expect(dialog).toBeVisible();
      await sendAuthoringMessage(dialog, AUTHORING_PROMPT);
      const ready = dialog.getByText(CANDIDATE_READY);
      if ((await ready.count()) === 0) {
        await sendAuthoringMessage(dialog, AUTHORING_FOLLOW_UP);
      }
      await expect(ready).toBeVisible({ timeout: 300_000 });
      await expect(dialog.getByText('Skill preview')).toBeVisible();
    });

    await test.step('Part C: publication puts the skill step on the rail', async () => {
      const nameField = dialog.getByLabel('Step name');
      await nameField.click();
      await nameField.pressSequentially(stepName, { delay: 8 });
      await expect(nameField).toHaveValue(stepName, { timeout: 20_000 });
      await chooseAddStepPosition(dialog, 'phase_end');
      await expect(dialog.getByText('Saved', { exact: true }).first()).toBeVisible({
        timeout: 30_000,
      });
      const save = dialog.getByRole('button', { name: SAVE_BUTTON });
      await expect(save).toBeEnabled();
      await save.click();

      await expect(dialog).toHaveCount(0, { timeout: 180_000 });
      await answerRailEditPrompt(page, 180_000);
      // The rail lands on the board with the new card highlighted.
      await expect(addedStepCard(page)).toContainText(stepName, { timeout: 180_000 });

      await page.goto(`/projects/${encodeURIComponent(deal.code)}/rail`);
      await expect(fullArray(page).getByText(stepName)).toBeVisible();
    });

    await test.step('Part A: removing the published step moves it to Removed steps', async () => {
      const card = stepCard(page, stepName);
      await expect(card).toBeVisible();
      await removeStepFromCard(page, card);
      await answerRailEditPrompt(page);
      await zoomOutToBoard(page);

      await expect(fullArray(page).getByText(stepName)).toHaveCount(0, { timeout: 30_000 });

      const removedSection = page.locator('details', { hasText: 'Removed steps' });
      await expect(removedSection).toBeVisible();
      await removedSection.locator('summary').click();
      const removedRow = removedSection.locator('li', { hasText: stepName });
      await expect(removedRow).toBeVisible();
      await expect(removedRow.getByText(/by Storm Duncan/)).toBeVisible();
    });
  });
});
