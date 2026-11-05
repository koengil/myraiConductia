import { test, expect } from '../support/fixtures';
import { zoomIntoCurrentStep, DRAFT_BUTTON } from '../support/rail';
import {
  createRailDeal,
  insertSkillStep,
  readSkillRuns,
} from '../support/railDealFixture';
import { FIELDS_SKILL } from '../support/ignatiousPublicationStub';

/**
 * Verification of skill run execution and results
 * (docs/superpowers/specs/2026-09-14-skill-run-execution-and-results-design.md).
 *
 * Scope note, deliberate rather than a gap. The hermetic tier blanks
 * IGNATIOUS_CONTROL_PLANE_URL, IGNATIOUS_API_URL and IGNATIOUS_API_KEY
 * (playwright.config.ts), and readIgnatiousConfig() returns null unless it has
 * both a base URL and a key, so the stream route answers 503 and every run
 * here ends failed. That is what exercises the failure record and the retained
 * history. Note the tier does point IGNATIOUS_SKILL_BENCH_URL at the
 * publication stub, which answers publication but not skill runs, so the bench
 * URL being set changes nothing for this spec. A real streamed reply needs a
 * running skill bench, which belongs to the live tier and to the manual
 * browser walk recorded with this work.
 *
 * What this spec does prove is the whole of what Conductia owns on either side
 * of that provider call: the step surface renders its single input from the
 * definition, the input survives a run, every terminal run is recorded against
 * the step with the binding the definition names, history accumulates newest
 * first, selecting an earlier run changes nothing about the input, and
 * completion stays a human action that no run outcome performs.
 */

const BINDING = {
  skillId: '2d362e20-0709-4ba0-bbd7-d21831148282',
  versionId: '0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6',
  digest: 'a'.repeat(64),
};

const HELPER_TEXT = 'Name the two decisions the board has to make.';
const FIRST_INPUT = 'Summarise the week for the board';
const SECOND_INPUT = 'Summarise the week, and name the open decisions';

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

test.describe('skill run execution and results', () => {
  test('an MD runs a skill-backed step twice and keeps both runs', async ({
    page,
    evidence,
    runId,
  }) => {
    const title = `Weekly project update ${runId}`;
    const deal = await createRailDeal(evidence.request, { runId });
    await insertSkillStep(deal.id, {
      stepId: `custom:${runId}`,
      title,
      description: 'Prepare a concise update for the board.',
      helperText: HELPER_TEXT,
      binding: BINDING,
      phaseIndex: 1,
      displayOrder: 0,
    });

    await page.goto(railUrl(deal.code));
    const focus = await openTheSkillStep(page, title);

    const runner = focus.getByRole('region', { name: 'Skill run' });
    await expect(runner).toBeVisible();
    await expect(runner.getByText(HELPER_TEXT)).toBeVisible();

    const input = runner.getByLabel('Additional instructions');
    await input.fill(FIRST_INPUT);
    await runner.getByRole('button', { name: DRAFT_BUTTON }).click();

    await expect(runner.getByRole('alert')).toBeVisible({ timeout: 60_000 });
    await expect(input).toHaveValue(FIRST_INPUT);

    const history = runner.getByRole('list', { name: 'Run history' });
    await expect(history.getByRole('listitem')).toHaveCount(1);

    await input.fill(SECOND_INPUT);
    await runner.getByRole('button', { name: DRAFT_BUTTON }).click();
    await expect(history.getByRole('listitem')).toHaveCount(2);
    await expect(input).toHaveValue(SECOND_INPUT);

    const recorded = await readSkillRuns(deal.id);
    expect(recorded.map((run) => run.input)).toEqual([SECOND_INPUT, FIRST_INPUT]);
    expect(recorded.every((run) => run.outcome === 'failed')).toBe(true);
    expect(recorded.every((run) => run.digest === BINDING.digest)).toBe(true);

    await history.getByRole('listitem').nth(1).getByRole('button').first().click();
    await expect(input).toHaveValue(SECOND_INPUT);
  });

  test('completion stays a human action that no run performs', async ({
    page,
    evidence,
    runId,
  }) => {
    const title = `Board readout ${runId}`;
    const deal = await createRailDeal(evidence.request, { runId });
    await insertSkillStep(deal.id, {
      stepId: `custom:${runId}`,
      title,
      description: 'Draft the readout.',
      helperText: HELPER_TEXT,
      binding: BINDING,
      phaseIndex: 1,
      displayOrder: 0,
    });

    await page.goto(railUrl(deal.code));
    const focus = await openTheSkillStep(page, title);
    const runner = focus.getByRole('region', { name: 'Skill run' });

    await runner.getByLabel('Additional instructions').fill(FIRST_INPUT);
    await runner.getByRole('button', { name: DRAFT_BUTTON }).click();
    await expect(runner.getByRole('alert')).toBeVisible({ timeout: 60_000 });

    // A failed run completes nothing: the step still reads as not done. (The
    // custom step sits ahead of the cursor, where no advance is offered: the
    // bare advance writes only the cursor, handoff E28.)
    await expect(focus.getByText('Done', { exact: true })).toHaveCount(0);
    await expect(focus.getByRole('button', { name: /^Mark (step )?complete$/ })).toHaveCount(0);
  });

  test('an MD fills the fields a skill declares and the run records them', async ({
    page,
    evidence,
    runId,
  }) => {
    const title = `Board pack ${runId}`;
    const deal = await createRailDeal(evidence.request, { runId });
    await insertSkillStep(deal.id, {
      stepId: `custom:${runId}`,
      title,
      description: 'Prepare the board pack.',
      helperText: HELPER_TEXT,
      binding: FIELDS_SKILL,
      phaseIndex: 1,
      displayOrder: 0,
    });

    await page.goto(railUrl(deal.code));
    const focus = await openTheSkillStep(page, title);
    const runner = focus.getByRole('region', { name: 'Skill run' });

    await expect(runner.getByLabel(/^As of/)).toBeVisible();
    await expect(runner.getByLabel('Audience')).toHaveValue('Board');

    await expect(runner.getByRole('button', { name: DRAFT_BUTTON })).toBeDisabled();
    await expect(runner.getByText('As of is required.')).toBeVisible();

    await runner.getByLabel(/^As of/).fill('2026-09-30');
    await runner.getByLabel('Additional instructions').fill('Keep it to one page');
    await runner.getByRole('button', { name: DRAFT_BUTTON }).click();
    await expect(runner.getByRole('alert')).toBeVisible({ timeout: 60_000 });

    // The alert can show while the run is still settling, before its row is
    // written, so wait for the recorded run rather than reading it at once.
    await expect.poll(async () => (await readSkillRuns(deal.id)).length, { timeout: 60_000 }).toBe(1);
    const [recorded] = await readSkillRuns(deal.id);
    expect(recorded.inputs).toEqual({ asOf: '2026-09-30', audience: 'Board' });
    expect(recorded.input).toBe('Keep it to one page');

    await page.reload();
    const again = (await openTheSkillStep(page, title)).getByRole('region', { name: 'Skill run' });
    await expect(again.getByLabel(/^As of/)).toHaveValue('2026-09-30');
  });
});
