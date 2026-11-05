import { test, expect } from '../support/fixtures';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { createRailDeal } from '../support/railDealFixture';
import { answerRailEditPrompt, escapeRegExp } from '../support/rail';
import {
  discardSeededDrafts,
  programPublicationStub,
  publicationStateOf,
  publicationStubCalls,
  seedAnchoredDraft,
  seedPublishableDraft,
  sweepPublications,
} from '../support/publicationDraftFixture';

const PREPARING_LABEL = 'Checking project';
const CONFIRM_PROMPT =
  'These existing steps look similar. Confirm to save anyway, or decline to revise the draft.';
const SAVE_ANYWAY = 'Save anyway';
const DECLINE_AND_REVISE = 'Decline and revise';
const SAVE_BUTTON = 'Save skill and add step';
const DUPLICATE_ACTIVE_MESSAGE = 'An active step already covers this skill.';
const DUPLICATE_DECLINED_MESSAGE =
  'The duplicate match was declined. Save again once the draft is corrected.';
const CANDIDATE_INVALID_MESSAGE =
  'This candidate is no longer valid. Correct the draft and save again.';
const CANDIDATE_STALE_MESSAGE =
  'The draft changed since saving started. Save again.';
const CHOOSE_NEW_POSITION = 'Choose a new position';

const SIMILAR_MATCH = {
  targetIndex: 0,
  classification: 'similar' as const,
  reasonCode: 'capability_similar' as const,
  confidence: 0.6,
};

const EXACT_MATCH = {
  targetIndex: 0,
  classification: 'exact' as const,
  reasonCode: 'identity_match' as const,
  confidence: 1,
};

type RailRow = { id: string; stepId: string; phaseIndex: number; removedAt: string | null };

async function railRow(
  request: APIRequestContext,
  dealCode: string,
  stepId: string,
): Promise<RailRow> {
  const response = await request.get(`/api/v1/deals/${encodeURIComponent(dealCode)}/rail`);
  expect(response.ok(), await response.text()).toBeTruthy();
  const body = (await response.json()) as { steps: RailRow[] };
  const row = body.steps.find((step) => step.stepId === stepId && step.removedAt === null);
  expect(row, `no active rail row for ${stepId}`).toBeTruthy();
  return row as RailRow;
}

function railUrl(dealCode: string): string {
  return `/projects/${encodeURIComponent(dealCode)}/rail`;
}

function fullArray(page: Page): Locator {
  return page.getByRole('region', { name: 'Rail overview' });
}

function focusView(page: Page): Locator {
  return page.getByRole('region', { name: 'Step detail' });
}

/**
 * After "Save skill and add step" the rail lands on the board (phase
 * overview) with the new card highlighted, focused and draggable; the MD is
 * asked about the change's scope over it.
 */
async function expectPublishedOnBoard(
  page: Page,
  dialog: Locator,
  name: string,
): Promise<void> {
  await expect(dialog).toHaveCount(0, { timeout: 30_000 });
  // Adding a step asks the MD (who holds rail editing rights) about its scope.
  await answerRailEditPrompt(page);
  await expect(focusView(page)).toHaveCount(0);
  const added = fullArray(page).locator('[data-highlight="new"]');
  await expect(added).toHaveCount(1, { timeout: 30_000 });
  await expect(added).toContainText(name);
  await expect(added.getByRole('button', { name: new RegExp(`^Step \\d+ · ${escapeRegExp(name)}`) })).toBeFocused();
}

async function openSkillBuilder(page: Page, dealCode: string): Promise<Locator> {
  await page.goto(railUrl(dealCode));
  await expect(fullArray(page)).toBeVisible();
  await page.getByRole('button', { name: 'Add new step' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Skill builder' });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function mdUserId(evidence: { me: () => Promise<{ user: { id: string } }> }): Promise<string> {
  const me = await evidence.me();
  return me.user.id;
}

async function publishBaselineSkill(
  page: Page,
  authorId: string,
  deal: { id: string; code: string },
  name: string,
): Promise<void> {
  await programPublicationStub({});
  await seedPublishableDraft({ dealId: deal.id, authorId, name });
  const dialog = await openSkillBuilder(page, deal.code);
  await dialog.getByRole('button', { name: SAVE_BUTTON }).click();
  await expectPublishedOnBoard(page, dialog, name);
}

test.describe('skill publication and rail insertion — MD', () => {
  test('publishing a durable candidate puts the skill step on the rail', async ({
    page,
    evidence,
    runId,
  }) => {
    const deal = await createRailDeal(evidence.request, { runId });
    await programPublicationStub({});
    const name = `Diligence Summariser ${runId}`;
    const draft = await seedPublishableDraft({
      dealId: deal.id,
      authorId: await mdUserId(evidence),
      name,
    });

    const dialog = await openSkillBuilder(page, deal.code);
    await dialog.getByRole('button', { name: SAVE_BUTTON }).click();

    await expectPublishedOnBoard(page, dialog, name);
    expect(await publicationStateOf(draft.draftId)).toBe('published');

    const calls = await publicationStubCalls();
    const paths = calls.map((call) => call.path.replace(/[0-9a-f-]{36}/, ':id'));
    expect(paths).toContain('/v1/conductia/skill-publications/:id/prepare');
    expect(paths).toContain('/v1/conductia/skill-publications/:id/publish');
    expect(calls.every((call) => call.authorization?.startsWith('Bearer '))).toBe(true);

    await page.goto(railUrl(deal.code));
    await expect(fullArray(page).getByText(name)).toBeVisible();

    await discardSeededDrafts(deal.id);
  });

  test('a similar existing step asks for confirmation before publishing', async ({
    page,
    evidence,
    runId,
  }) => {
    const deal = await createRailDeal(evidence.request, { runId });
    const authorId = await mdUserId(evidence);
    await publishBaselineSkill(page, authorId, deal, `Baseline Skill ${runId}`);

    await programPublicationStub({ prepare: { matches: [SIMILAR_MATCH] } });
    const draft = await seedPublishableDraft({
      dealId: deal.id,
      authorId,
      name: `Similar Skill ${runId}`,
    });

    const dialog = await openSkillBuilder(page, deal.code);
    await dialog.getByRole('button', { name: SAVE_BUTTON }).click();

    await expect(dialog.getByText(CONFIRM_PROMPT)).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByRole('button', { name: SAVE_ANYWAY })).toBeEnabled();
    await expect(dialog.getByRole('button', { name: DECLINE_AND_REVISE })).toBeEnabled();
    expect(await publicationStateOf(draft.draftId)).toBe('confirmation_required');

    await discardSeededDrafts(deal.id);
  });

  test('confirming a similar match publishes the step', async ({ page, evidence, runId }) => {
    const deal = await createRailDeal(evidence.request, { runId });
    const authorId = await mdUserId(evidence);
    await publishBaselineSkill(page, authorId, deal, `Baseline Skill ${runId}`);

    await programPublicationStub({ prepare: { matches: [SIMILAR_MATCH] } });
    const name = `Confirmed Skill ${runId}`;
    const draft = await seedPublishableDraft({ dealId: deal.id, authorId, name });

    const dialog = await openSkillBuilder(page, deal.code);
    await dialog.getByRole('button', { name: SAVE_BUTTON }).click();
    await expect(dialog.getByText(CONFIRM_PROMPT)).toBeVisible({ timeout: 30_000 });
    await dialog.getByRole('button', { name: SAVE_ANYWAY }).click();

    await expectPublishedOnBoard(page, dialog, name);
    expect(await publicationStateOf(draft.draftId)).toBe('published');

    await page.goto(railUrl(deal.code));
    await expect(fullArray(page).getByText(name)).toBeVisible();

    await discardSeededDrafts(deal.id);
  });

  test('declining a similar match refuses the publication and states why', async ({
    page,
    evidence,
    runId,
  }) => {
    const deal = await createRailDeal(evidence.request, { runId });
    const authorId = await mdUserId(evidence);
    await publishBaselineSkill(page, authorId, deal, `Baseline Skill ${runId}`);

    await programPublicationStub({ prepare: { matches: [SIMILAR_MATCH] } });
    const name = `Declined Skill ${runId}`;
    const draft = await seedPublishableDraft({ dealId: deal.id, authorId, name });

    const dialog = await openSkillBuilder(page, deal.code);
    await dialog.getByRole('button', { name: SAVE_BUTTON }).click();
    await expect(dialog.getByText(CONFIRM_PROMPT)).toBeVisible({ timeout: 30_000 });
    await dialog.getByRole('button', { name: DECLINE_AND_REVISE }).click();

    await expect(dialog.getByText(DUPLICATE_DECLINED_MESSAGE)).toBeVisible({ timeout: 30_000 });
    expect(await publicationStateOf(draft.draftId)).toBe('failed');

    await page.goto(railUrl(deal.code));
    await expect(fullArray(page).getByText(name)).toHaveCount(0);

    await discardSeededDrafts(deal.id);
  });

  test('an exact match against an active step blocks publication outright', async ({
    page,
    evidence,
    runId,
  }) => {
    const deal = await createRailDeal(evidence.request, { runId });
    const authorId = await mdUserId(evidence);
    await publishBaselineSkill(page, authorId, deal, `Baseline Skill ${runId}`);

    await programPublicationStub({ prepare: { matches: [EXACT_MATCH] } });
    const name = `Exact Duplicate ${runId}`;
    const draft = await seedPublishableDraft({ dealId: deal.id, authorId, name });

    const dialog = await openSkillBuilder(page, deal.code);
    await dialog.getByRole('button', { name: SAVE_BUTTON }).click();

    await expect(dialog.getByText(DUPLICATE_ACTIVE_MESSAGE)).toBeVisible({ timeout: 30_000 });
    expect(await publicationStateOf(draft.draftId)).toBe('failed');

    await page.goto(railUrl(deal.code));
    await expect(fullArray(page).getByText(name)).toHaveCount(0);

    await discardSeededDrafts(deal.id);
  });

  test('a rejected candidate fails the publication with a correctable reason', async ({
    page,
    evidence,
    runId,
  }) => {
    const deal = await createRailDeal(evidence.request, { runId });
    await programPublicationStub({
      prepare: { failure: { kind: 'status', status: 422, error: 'candidate_invalid' } },
    });
    const draft = await seedPublishableDraft({
      dealId: deal.id,
      authorId: await mdUserId(evidence),
      name: `Invalid Candidate ${runId}`,
    });

    const dialog = await openSkillBuilder(page, deal.code);
    await dialog.getByRole('button', { name: SAVE_BUTTON }).click();

    await expect(dialog.getByText(CANDIDATE_INVALID_MESSAGE)).toBeVisible({ timeout: 30_000 });
    expect(await publicationStateOf(draft.draftId)).toBe('failed');

    await discardSeededDrafts(deal.id);
  });

  test('a stale candidate fails the publication and asks for another save', async ({
    page,
    evidence,
    runId,
  }) => {
    const deal = await createRailDeal(evidence.request, { runId });
    await programPublicationStub({
      prepare: { failure: { kind: 'status', status: 409, error: 'candidate_stale' } },
    });
    const draft = await seedPublishableDraft({
      dealId: deal.id,
      authorId: await mdUserId(evidence),
      name: `Stale Candidate ${runId}`,
    });

    const dialog = await openSkillBuilder(page, deal.code);
    await dialog.getByRole('button', { name: SAVE_BUTTON }).click();

    await expect(dialog.getByText(CANDIDATE_STALE_MESSAGE)).toBeVisible({ timeout: 30_000 });
    expect(await publicationStateOf(draft.draftId)).toBe('failed');

    await discardSeededDrafts(deal.id);
  });

  test('an unreachable skill bench leaves the publication in progress rather than failing it', async ({
    page,
    evidence,
    runId,
  }) => {
    const deal = await createRailDeal(evidence.request, { runId });
    await programPublicationStub({ prepare: { failure: { kind: 'status', status: 503 } } });
    const draft = await seedPublishableDraft({
      dealId: deal.id,
      authorId: await mdUserId(evidence),
      name: `Unreachable Bench ${runId}`,
    });

    const dialog = await openSkillBuilder(page, deal.code);
    await dialog.getByRole('button', { name: SAVE_BUTTON }).click();

    await expect(dialog.getByText(PREPARING_LABEL)).toBeVisible({ timeout: 30_000 });
    expect(await publicationStateOf(draft.draftId)).toBe('preparing');
    await expect(dialog).toBeVisible();

    await discardSeededDrafts(deal.id);
  });

  test('a malformed bench response does not present the step as published', async ({
    page,
    evidence,
    runId,
  }) => {
    const deal = await createRailDeal(evidence.request, { runId });
    await programPublicationStub({ prepare: { failure: { kind: 'malformed' } } });
    const name = `Malformed Response ${runId}`;
    const draft = await seedPublishableDraft({
      dealId: deal.id,
      authorId: await mdUserId(evidence),
      name,
    });

    const dialog = await openSkillBuilder(page, deal.code);
    await dialog.getByRole('button', { name: SAVE_BUTTON }).click();

    await expect(dialog.getByText(PREPARING_LABEL)).toBeVisible({ timeout: 30_000 });
    expect(await publicationStateOf(draft.draftId)).not.toBe('published');
    await expect(dialog).toBeVisible();

    await page.goto(railUrl(deal.code));
    await expect(fullArray(page).getByText(name)).toHaveCount(0);

    await discardSeededDrafts(deal.id);
  });

  test('an anchor removed after admission asks the MD to choose a new position, excluding the removed step', async ({
    page,
    evidence,
    runId,
  }) => {
    const deal = await createRailDeal(evidence.request, { runId });
    const anchor = await railRow(evidence.request, deal.code, 'p2-s30');
    await programPublicationStub({ prepare: { failure: { kind: 'status', status: 503 } } });
    const draft = await seedAnchoredDraft({
      dealId: deal.id,
      authorId: await mdUserId(evidence),
      name: `Anchored Skill ${runId}`,
      anchorDealStepId: anchor.id,
      phaseIndex: anchor.phaseIndex,
    });

    const dialog = await openSkillBuilder(page, deal.code);
    await dialog.getByRole('button', { name: SAVE_BUTTON }).click();
    await expect
      .poll(() => publicationStateOf(draft.draftId), { timeout: 30_000 })
      .toBe('preparing');

    const removed = await evidence.request.delete(
      `/api/v1/deals/${encodeURIComponent(deal.code)}/rail/steps/${encodeURIComponent(anchor.id)}`,
    );
    const removedBody = await removed.text();
    expect(removed.ok(), removedBody).toBeTruthy();
    expect(JSON.parse(removedBody) as { removed: boolean }).toMatchObject({ removed: true });

    await programPublicationStub({});
    await expect
      .poll(
        async () => {
          await sweepPublications(evidence.request);
          return publicationStateOf(draft.draftId);
        },
        { timeout: 60_000, intervals: [2_000] },
      )
      .toBe('needs_placement');

    await expect(dialog.getByText(CHOOSE_NEW_POSITION)).toBeVisible({ timeout: 30_000 });
    await dialog.getByLabel('New phase').selectOption(String(anchor.phaseIndex));
    const positionSelect = dialog.getByLabel('New position');
    await expect(positionSelect).toBeVisible();
    const optionValues = await positionSelect
      .locator('option')
      .evaluateAll((options) => options.map((option) => option.getAttribute('value') ?? ''));
    expect(optionValues).not.toContain(`after:${anchor.id}`);

    await discardSeededDrafts(deal.id);
  });
});
