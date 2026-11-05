import { test, expect } from '../support/fixtures';
import { zoomIntoCurrentStep } from '../support/rail';
import {
  createRailDeal,
  insertSkillStep,
  insertSucceededRun,
  insertTaughtRevision,
  readRevisionRows,
} from '../support/railDealFixture';

const BINDING = {
  skillId: '2d362e20-0709-4ba0-bbd7-d21831148282',
  versionId: '0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6',
  digest: 'a'.repeat(64),
};

const FIRST_OUTPUT = [
  '# Weekly update',
  '',
  'Revenue fell in the quarter.',
  '',
  '- Two buyers asked for the data room.',
  '- The board meets on Friday.',
].join('\n');

const EDITED_OUTPUT = FIRST_OUTPUT.replace(
  'Revenue fell in the quarter.',
  'Revenue rose 12% in the quarter.',
);

function railUrl(dealCode: string): string {
  return `/projects/${encodeURIComponent(dealCode)}/rail`;
}

async function openTheSkillStep(page: import('@playwright/test').Page, title: string) {
  const focus = await zoomIntoCurrentStep(page);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (await focus.getByRole('heading', { name: title }).count()) break;
    const previous = focus.getByRole('button', { name: /Previous step/ });
    if ((await previous.count()) === 0) break;
    await previous.click();
  }
  await expect(focus.getByRole('heading', { name: title })).toBeVisible();
  return focus;
}

test.describe('skill output revisions', () => {
  test.beforeEach(async ({}, testInfo) => {
    test.skip(
      testInfo.project.name === 'live',
      'the skill-step fixture writes straight to a local database; a deployed environment owns its own rows',
    );
  });

  test('an MD edits a passage by hand, restores the first output, and keeps every version', async ({
    page,
    evidence,
    runId,
  }) => {
    const title = `Weekly update ${runId}`;
    const stepId = `custom:${runId}`;
    const deal = await createRailDeal(evidence.request, { runId });
    await insertSkillStep(deal.id, {
      stepId,
      title,
      description: 'Prepare a concise update for the board.',
      helperText: 'What to emphasise.',
      binding: BINDING,
      phaseIndex: 1,
      displayOrder: 0,
    });
    const me = await evidence.request.get('/api/v1/me');
    const actorId = ((await me.json()) as { user: { id: string } }).user.id;
    const rootId = await insertSucceededRun(deal.id, {
      stepId,
      actorId,
      binding: BINDING,
      resultText: FIRST_OUTPUT,
    });

    await page.goto(railUrl(deal.code));
    const focus = await openTheSkillStep(page, title);
    const runner = focus.getByRole('region', { name: 'Skill run' });
    await expect(runner.getByText(/Version 1 of 1/)).toBeVisible();

    await runner.getByRole('button', { name: 'Review output' }).click();
    const review = page.getByRole('dialog', { name: 'Review output' });
    await review.getByText('Revenue fell in the quarter.').click();
    await review.getByRole('button', { name: 'Edit text' }).click();
    await review.getByLabel('Passage text, in Markdown').fill('Revenue rose 12% in the quarter.');
    await review.getByRole('button', { name: 'Save edit' }).click();
    await review.getByRole('button', { name: 'Apply 1 edit' }).click();

    await expect(review.getByText('1 edit applied. Version 2 is recorded.')).toBeVisible();
    await expect(review.getByText('Version 2 of 2')).toBeVisible();
    await expect(review.getByText('Revenue rose 12% in the quarter.')).toBeVisible();
    await expect(review.getByText('Two buyers asked for the data room.')).toBeVisible();

    await review.getByRole('button', { name: 'Earlier version' }).click();
    await expect(review.getByText('This is an earlier version. It is read-only.')).toBeVisible();
    await review.getByRole('button', { name: 'Restore this version' }).click();
    await expect(review.getByText('Version 1 restored. Version 3 is recorded.')).toBeVisible();
    await expect(review.getByText('Version 3 of 3')).toBeVisible();

    await review.getByRole('button', { name: 'Close' }).click();
    // The dialog animates out inside the runner; wait for it to go so the
    // runner's own version line is the one read.
    await expect(review).toHaveCount(0);
    await expect(runner.getByText(/Version 3 of 3/)).toBeVisible();
    await expect(runner.getByText('Revenue fell in the quarter.')).toBeVisible();

    const rows = await readRevisionRows(deal.id);
    expect(rows.map((row) => [row.outcome, row.result_text])).toEqual([
      ['succeeded', EDITED_OUTPUT],
      ['succeeded', FIRST_OUTPUT],
    ]);
    expect(rows[0]?.parent_run_id).toBe(rootId);
    expect(rows[1]?.parent_run_id).toBe(rows[0]?.id);
    expect(rows[1]?.inputs).toEqual({ kind: 'restore', restoredFrom: rootId });

    const history = runner.getByRole('list', { name: 'Run history' });
    await expect(history.getByRole('listitem')).toHaveCount(1);
  });

  test('a comment is refused, and nothing is recorded, while no skill service is configured', async ({
    page,
    evidence,
    runId,
  }) => {
    const title = `Board readout ${runId}`;
    const stepId = `custom:${runId}`;
    const deal = await createRailDeal(evidence.request, { runId });
    await insertSkillStep(deal.id, {
      stepId,
      title,
      description: 'Draft the readout.',
      helperText: 'What to emphasise.',
      binding: BINDING,
      phaseIndex: 1,
      displayOrder: 0,
    });
    const me = await evidence.request.get('/api/v1/me');
    const actorId = ((await me.json()) as { user: { id: string } }).user.id;
    await insertSucceededRun(deal.id, { stepId, actorId, binding: BINDING, resultText: FIRST_OUTPUT });

    await page.goto(railUrl(deal.code));
    const focus = await openTheSkillStep(page, title);
    await focus.getByRole('button', { name: 'Review output' }).click();
    const review = page.getByRole('dialog', { name: 'Review output' });
    await review.getByText('The board meets on Friday.').click();
    await review.getByLabel('What should change in this passage').fill('Say which Friday.');
    await review.getByRole('button', { name: 'Add comment' }).click();
    await review.getByRole('button', { name: 'Apply 1 edit' }).click();

    await expect(review.getByRole('alert')).toHaveText(
      'Agent skills are not available on this environment.',
    );
    await expect(review.getByRole('list', { name: 'Pending' })).toContainText('Say which Friday.');
    expect(await readRevisionRows(deal.id)).toEqual([]);
  });

  test('an MD sends a taught comment to Improve this skill, and it is offered once', async ({
    page,
    evidence,
    runId,
  }) => {
    const title = `Teach update ${runId}`;
    const stepId = `custom:${runId}`;
    const deal = await createRailDeal(evidence.request, { runId });
    await insertSkillStep(deal.id, {
      stepId,
      title,
      description: 'Prepare a concise update for the board.',
      helperText: 'What to emphasise.',
      binding: BINDING,
      phaseIndex: 1,
      displayOrder: 0,
    });
    const me = await evidence.request.get('/api/v1/me');
    const actorId = ((await me.json()) as { user: { id: string } }).user.id;
    const rootRunId = await insertSucceededRun(deal.id, {
      stepId,
      actorId,
      binding: BINDING,
      resultText: FIRST_OUTPUT,
    });
    await insertTaughtRevision(deal.id, {
      rootRunId,
      actorId,
      binding: BINDING,
      parentText: FIRST_OUTPUT,
      comment: 'End every bullet with a period.',
      passage: 'Two buyers asked for the data room.',
      replacement: 'Two buyers asked for the data room.',
    });

    await page.goto(railUrl(deal.code));
    const focus = await openTheSkillStep(page, title);
    const runner = focus.getByRole('region', { name: 'Skill run' });
    await runner.getByRole('button', { name: 'Teach the skill · 1 comment' }).click();

    const dialog = page.getByRole('dialog', { name: 'Enhance skill' });
    const composer = dialog.getByLabel('Message');
    await expect(composer).toHaveValue(/End every bullet with a period\./);
    await expect(composer).toHaveValue(/Learned from reviews/);
    await dialog.getByRole('button', { name: 'Send' }).click();
    await expect(composer).toHaveValue('');

    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(runner.getByRole('button', { name: /Teach the skill/ })).toHaveCount(0);
    await page.reload();
    const reopened = await openTheSkillStep(page, title);
    await expect(reopened.getByRole('region', { name: 'Skill run' }).getByRole('button', { name: 'Review output' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Teach the skill/ })).toHaveCount(0);
  });
});
