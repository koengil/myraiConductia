import { randomUUID } from 'node:crypto';
import { expect, test } from '../support/fixtures';
import { newCollectedContext } from '../support/cspViolations';
import type { APIRequestContext, Browser, BrowserContext, Locator, Page } from '@playwright/test';
import {
  countSkillRuns,
  programRailTemplateStub,
  railTemplateStubCalls,
  readDealBindings,
  readDealSteps,
  readDealTemplateRevision,
  seedTemplateJourney,
  type DealStepRow,
  type TemplateJourney,
} from '../support/railTemplateFixture';

const CONFLICTS_APPROVER = 'Pat Rivera';
const TEMPLATE_DESCRIPTION = 'Used on every technology mandate.';

type RailStepShape = { label: string; phaseIndex: number };

type TemplateRow = { id: string; revisionId: string; name: string };

function shapeOf(steps: DealStepRow[]): RailStepShape[] {
  return steps
    .filter((step) => step.removedAt === null)
    .sort((a, b) => a.displayOrder - b.displayOrder)
    .map((step) => ({
      label: step.origin === 'catalog' ? step.stepId : (step.title ?? step.stepId),
      phaseIndex: step.phaseIndex,
    }));
}

function contiguousOrder(steps: DealStepRow[]): number[] {
  return steps
    .filter((step) => step.removedAt === null)
    .map((step) => step.displayOrder)
    .sort((a, b) => a - b);
}

function catalogStepIds(steps: DealStepRow[]): string[] {
  return steps
    .filter((step) => step.removedAt === null && step.origin === 'catalog')
    .sort((a, b) => a.displayOrder - b.displayOrder)
    .map((step) => step.stepId);
}

async function openSaveDialog(page: Page, dealCode: string): Promise<Locator> {
  await page.goto(`/projects/${encodeURIComponent(dealCode)}/rail`);
  await expect(page.getByRole('region', { name: 'Rail overview' })).toBeVisible();
  const trigger = page.getByRole('button', { name: 'Save rail', exact: true });
  await expect(trigger).toBeVisible();
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Save rail' });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function saveNewTemplate(page: Page, dealCode: string, name: string): Promise<void> {
  const dialog = await openSaveDialog(page, dealCode);
  await dialog.getByLabel('Name', { exact: true }).fill(name);
  await dialog.getByLabel('Description', { exact: true }).fill(TEMPLATE_DESCRIPTION);
  await dialog.getByRole('button', { name: 'Save rail', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(`Saved as ${name}, version 1.`)).toBeVisible();
}

async function replaceTemplate(
  page: Page,
  dealCode: string,
  name: string,
  version: number,
): Promise<void> {
  const dialog = await openSaveDialog(page, dealCode);
  await dialog.getByRole('radio', { name: 'Replace existing' }).check();
  const chooser = dialog.getByRole('combobox', { name: 'Saved rail' });
  await expect(chooser).toBeVisible();
  await chooser.selectOption({ label: name });
  await dialog.getByRole('button', { name: 'Replace rail', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(`Saved as ${name}, version ${version}.`)).toBeVisible();
}

type TeamChoice = { memberName: string; dealRole: string };

async function runGate0(
  page: Page,
  opts: {
    codename: string;
    leadName: string;
    templateName?: string;
    chooseTeamRole?: boolean;
    submitTwice?: boolean;
  },
): Promise<TeamChoice | null> {
  await page.goto('/projects');
  await page.getByRole('button', { name: /Switch deal|Select a deal/ }).click();
  await page.getByRole('dialog', { name: 'Switch deal' }).getByRole('button', { name: 'New deal' }).click();

  const wizard = page.getByRole('dialog', { name: 'New mandate' });
  await expect(wizard).toBeVisible();

  await wizard.getByPlaceholder('Search a registered lead…').fill(opts.leadName);
  await wizard
    .getByRole('listbox', { name: 'Matching companies' })
    .getByRole('option', { name: opts.leadName })
    .click();
  await expect(wizard.getByRole('button', { name: 'Regenerate' })).toBeEnabled();
  await wizard.getByLabel('Code name', { exact: true }).fill(opts.codename);

  const chooser = wizard.getByRole('combobox', { name: 'Rail' });
  await expect(chooser).toBeVisible();
  await expect(chooser).toHaveValue('standard');
  if (opts.templateName !== undefined) {
    await chooser.selectOption({ label: opts.templateName });
    const preview = wizard.getByRole('list', { name: 'Saved rail steps' });
    await expect(preview.getByRole('listitem').first()).toBeVisible();
  }
  await wizard.getByRole('button', { name: 'Next' }).click();

  await wizard.getByLabel('Approved by').fill(CONFLICTS_APPROVER);
  await wizard.getByLabel('Confirm the conflicts approval').check();
  await wizard.getByRole('button', { name: 'Next' }).click();

  let choice: TeamChoice | null = null;
  if (opts.chooseTeamRole === true) {
    const roleSelect = wizard.getByRole('combobox', { name: /^Deal role for / }).first();
    const label = await roleSelect.getAttribute('aria-label');
    const memberName = (label ?? '').replace('Deal role for ', '');
    await wizard.getByRole('checkbox', { name: memberName, exact: true }).check();
    await expect(roleSelect).toBeEnabled();
    const current = await roleSelect.inputValue();
    const values = await roleSelect.locator('option').evaluateAll((options) =>
      options.map((option) => (option as HTMLOptionElement).value),
    );
    const next = values.find((value) => value !== current);
    expect(next, 'the deal role list offers only one role').toBeTruthy();
    await roleSelect.selectOption(next!);
    choice = { memberName, dealRole: next! };
  }
  await wizard.getByRole('button', { name: 'Next' }).click();

  // The entry point: a saved rail opens at its own first step, so the
  // select is locked; the default rail leaves it open on the default.
  await wizard.getByRole('button', { name: 'Next' }).click();
  const entry = wizard.getByRole('combobox', { name: 'Starting step' });
  if (opts.templateName !== undefined) {
    await expect(entry).toBeDisabled();
  } else {
    await expect(entry).toBeEnabled();
  }

  await wizard.getByRole('button', { name: 'Create the mandate' }).click();
  if (opts.submitTwice === true) {
    await expect(wizard.getByRole('button', { name: 'Abandon and start over' })).toBeVisible();
    await wizard.getByRole('button', { name: 'Create the mandate' }).click();
  }
  return choice;
}

async function landedDealCode(page: Page): Promise<string> {
  await page.waitForURL(/\/projects\/[^/]+\/rail/);
  const code = new URL(page.url()).pathname.split('/')[2];
  expect(code, 'no deal code in the landing URL').toBeTruthy();
  return decodeURIComponent(code);
}

async function dealIdOf(request: APIRequestContext, code: string): Promise<string> {
  const response = await request.get(`/api/v1/deals/${encodeURIComponent(code)}`);
  expect(response.ok(), await response.text()).toBeTruthy();
  return ((await response.json()) as { deal: { id: string } }).deal.id;
}

async function listTemplates(request: APIRequestContext): Promise<TemplateRow[]> {
  const response = await request.get('/api/v1/rail-templates');
  expect(response.ok(), await response.text()).toBeTruthy();
  return ((await response.json()) as { templates: TemplateRow[] }).templates;
}

async function namedTemplate(request: APIRequestContext, name: string): Promise<TemplateRow> {
  const found = (await listTemplates(request)).find((template) => template.name === name);
  expect(found, `no saved rail named ${name}`).toBeTruthy();
  return found!;
}

async function removeSourceStep(
  request: APIRequestContext,
  fixture: TemplateJourney,
): Promise<void> {
  const response = await request.delete(
    `/api/v1/deals/${encodeURIComponent(fixture.source.code)}/rail/steps/${fixture.secondRemovableStepRowId}`,
  );
  expect(response.ok(), await response.text()).toBeTruthy();
}

test.describe('saved rail templates', () => {
  let contexts: BrowserContext[] = [];

  test.beforeEach(async ({}, testInfo) => {
    test.skip(
      testInfo.project.name === 'live',
      'the template fixture writes straight to a local database; a deployed environment owns its own rows',
    );
    contexts = [];
    await programRailTemplateStub({});
  });

  test.afterEach(async () => {
    for (const context of contexts) await context.close();
    contexts = [];
  });

  async function seedAndSignIn(
    browser: Browser,
    runId: string,
    baseURL: string | undefined,
  ): Promise<{
    fixture: TemplateJourney;
    directorPage: Page;
    director: BrowserContext;
    creator: BrowserContext;
  }> {
    expect(baseURL, 'the hermetic project must supply a base URL').toBeTruthy();
    const fixture = await seedTemplateJourney({ runId, baseURL: baseURL! });
    const director = await newCollectedContext(browser, {
      storageState: fixture.sourceDirectorStorageState,
    });
    const creator = await newCollectedContext(browser, {
      storageState: fixture.secondCreatorStorageState,
    });
    contexts.push(director, creator);
    return { fixture, directorPage: await director.newPage(), director, creator };
  }

  test('replacement changes only later deals', async ({ browser, runId, baseURL }) => {
    test.setTimeout(300_000);
    const { fixture, directorPage, director, creator } = await seedAndSignIn(
      browser,
      runId,
      baseURL,
    );
    const templateName = `Technology sell-side ${runId}`;

    await saveNewTemplate(directorPage, fixture.source.code, templateName);
    expect(
      await readDealTemplateRevision(fixture.source.id),
      'the deal that saved the rail does not follow it',
    ).toBe((await namedTemplate(director.request, templateName)).revisionId);

    const retained = await railTemplateStubCalls('retain');
    expect(retained, 'the save did not reach the skill service').toHaveLength(1);
    expect(
      retained[0].skills.map((skill) => skill.source.versionId),
      'the saved rail carried a version other than the step default',
    ).toEqual([fixture.selectedVersionId]);

    const sourceSteps = await readDealSteps(fixture.source.id);

    const otherPage = await creator.newPage();
    await otherPage.goto('/projects');
    await expect(
      otherPage.getByRole('button', { name: /Switch deal|Select a deal/ }),
      'a colleague who holds no seat on the source deal cannot reach mandate creation',
    ).toBeVisible();

    const teamChoice = await runGate0(otherPage, {
      codename: `Project TemplateOne ${runId}`,
      leadName: fixture.leadName,
      templateName,
      chooseTeamRole: true,
    });
    expect(teamChoice, 'the wizard offered no colleague to place on the deal').toBeTruthy();
    const firstCode = await landedDealCode(otherPage);

    // Using a saved rail grants no seat on the deal it came from, so that deal
    // must read exactly like a code that was never issued (decision-log D65):
    // the same codename and year, and the number 000, which mintDealCode never
    // issues (its suffix is 100-999), so no fixture deal can collide with it.
    const madeUpCode = fixture.source.code.replace(/-\d{3}$/, '-000');
    expect(madeUpCode, 'the source deal code is not CODENAME5-YYYY-NNN').not.toBe(
      fixture.source.code,
    );
    const answer = async (code: string) => {
      const response = await creator.request.get(`/api/v1/deals/${encodeURIComponent(code)}`);
      return { status: response.status(), body: await response.text() };
    };
    const madeUp = await answer(madeUpCode);
    expect(madeUp.status, 'the made-up code is not a 404').toBe(404);
    expect(
      await answer(fixture.source.code),
      'using a saved rail must not grant access to, or reveal, the deal it came from',
    ).toEqual(madeUp);

    const firstId = await dealIdOf(creator.request, firstCode);
    const firstSteps = await readDealSteps(firstId);
    expect(shapeOf(firstSteps)).toEqual(shapeOf(sourceSteps));
    const firstLabels = shapeOf(firstSteps).map((step) => step.label);
    expect(firstLabels, 'the manual step was not copied').toContain(fixture.manualStepTitle);
    expect(firstLabels, 'the skill step was not copied').toContain(fixture.skillStepTitle);
    expect(firstLabels, 'a step removed from the source was copied anyway').not.toContain(
      fixture.removedStepId,
    );
    expect(
      firstSteps.filter((step) => step.stepId === fixture.removedStepId && step.removedAt !== null),
      'a standard step the saved rail leaves out must arrive removed, so it can be restored',
    ).toHaveLength(1);
    expect(contiguousOrder(firstSteps)).toEqual(
      firstSteps.filter((step) => step.removedAt === null).map((_, index) => index + 1),
    );
    expect(
      firstSteps.map((step) => step.id).filter((id) => sourceSteps.some((s) => s.id === id)),
      'a deal created from a saved rail reused the source step identities',
    ).toEqual([]);
    expect(
      firstSteps.filter((step) => step.assignedTo !== null),
      'a rail created from a template arrived with someone already assigned',
    ).toEqual([]);
    expect(
      firstSteps.filter((step) => step.status === 'complete' || step.status === 'skipped'),
      'a rail created from a template arrived with completed or skipped work',
    ).toEqual([]);
    await expect(countSkillRuns(firstId)).resolves.toBe(0);

    const firstBindings = await readDealBindings(firstId);
    expect(firstBindings).toHaveLength(1);
    expect(firstBindings[0].source).toBe('template');
    expect(firstBindings[0].skillId).not.toBe(fixture.selectedSkillId);
    expect(firstBindings[0].versionId).not.toBe(fixture.selectedVersionId);
    expect(firstBindings[0].versionId).not.toBe(fixture.oneOffVersionId);

    const team = await creator.request.get(`/api/v1/deals/${encodeURIComponent(firstCode)}/members`);
    expect(team.ok(), await team.text()).toBeTruthy();
    const roster = (await team.json()) as {
      members: Array<{ name?: string | null; displayName?: string | null; dealRole?: string | null }>;
    };
    const placed = roster.members.find(
      (member) => (member.displayName ?? member.name ?? '') === teamChoice!.memberName,
    );
    expect(placed, `${teamChoice!.memberName} is not on the deal the saved rail created`).toBeTruthy();
    expect(
      placed?.dealRole,
      'the team selection made at Gate 0 did not survive a saved-rail create',
    ).toBe(teamChoice!.dealRole);

    const firstRevision = await readDealTemplateRevision(firstId);
    const beforeShape = shapeOf(firstSteps);
    const beforeBindings = firstBindings;

    await removeSourceStep(director.request, fixture);
    await replaceTemplate(directorPage, fixture.source.code, templateName, 2);
    expect(
      await readDealTemplateRevision(fixture.source.id),
      'the deal that saved the rail does not follow it',
    ).toBe((await namedTemplate(director.request, templateName)).revisionId);

    await runGate0(otherPage, {
      codename: `Project TemplateTwo ${runId}`,
      leadName: fixture.leadName,
      templateName,
    });
    const secondCode = await landedDealCode(otherPage);
    const secondId = await dealIdOf(creator.request, secondCode);

    const secondSteps = await readDealSteps(secondId);
    expect(shapeOf(secondSteps)).toEqual(shapeOf(await readDealSteps(fixture.source.id)));
    expect(catalogStepIds(secondSteps)).not.toContain(fixture.secondRemovableStepId);
    expect(await readDealTemplateRevision(secondId)).not.toBe(firstRevision);

    expect(
      shapeOf(await readDealSteps(firstId)),
      'the earlier deal moved when the saved rail was replaced',
    ).toEqual(beforeShape);
    expect(await readDealBindings(firstId)).toEqual(beforeBindings);
    expect(await readDealTemplateRevision(firstId)).toBe(firstRevision);
  });

  test('keeps the default rail as the default choice', async ({ browser, runId, baseURL }) => {
    test.setTimeout(240_000);
    const { fixture, directorPage, creator } = await seedAndSignIn(browser, runId, baseURL);
    await saveNewTemplate(directorPage, fixture.source.code, `Standard check ${runId}`);

    const otherPage = await creator.newPage();
    await runGate0(otherPage, {
      codename: `Project TemplateStandard ${runId}`,
      leadName: fixture.leadName,
    });
    const code = await landedDealCode(otherPage);
    const dealId = await dealIdOf(creator.request, code);

    expect(shapeOf(await readDealSteps(dealId))).toHaveLength(fixture.baselineStepCount);
    expect(await readDealTemplateRevision(dealId)).toBeNull();
    expect(await readDealBindings(dealId)).toEqual([]);
  });

  test('a creator at another bank can neither list nor use the saved rail', async ({
    browser,
    runId,
    baseURL,
  }) => {
    test.setTimeout(240_000);
    const { fixture, directorPage, director } = await seedAndSignIn(browser, runId, baseURL);
    const templateName = `Walled off ${runId}`;
    await saveNewTemplate(directorPage, fixture.source.code, templateName);

    const mine = await namedTemplate(director.request, templateName);
    const preview = await director.request.get(`/api/v1/rail-templates/${mine.id}`);
    expect(preview.ok(), await preview.text()).toBeTruthy();
    const previewText = await preview.text();
    expect(previewText, 'a picker projection leaked the source deal id').not.toContain(
      fixture.source.id,
    );
    expect(previewText, 'a picker projection leaked the source deal code').not.toContain(
      fixture.source.code,
    );

    const outside = await newCollectedContext(browser, {
      storageState: fixture.outsideCreatorStorageState,
    });
    contexts.push(outside);

    const theirList = await outside.request.get('/api/v1/rail-templates');
    const theirNames =
      theirList.status() === 200
        ? ((await theirList.json()) as { templates: TemplateRow[] }).templates.map(
            (template) => template.name,
          )
        : [];
    expect(theirNames, 'another bank could list this company saved rail').not.toContain(
      templateName,
    );

    const theirPreview = await outside.request.get(`/api/v1/rail-templates/${mine.id}`);
    expect([403, 404]).toContain(theirPreview.status());

    const theirCreate = await outside.request.post('/api/v1/deals', {
      data: {
        codename: `Project Outside ${runId}`,
        targetName: `Outside target ${runId}`,
        conflictsAttestation: {
          approvedBy: CONFLICTS_APPROVER,
          approvedOn: new Date().toISOString().slice(0, 10),
        },
        requestId: randomUUID(),
        railTemplate: { templateId: mine.id, revisionId: mine.revisionId },
      },
    });
    expect([403, 404, 409]).toContain(theirCreate.status());
  });

  test('a lost provider response creates the mandate once when it is retried', async ({
    browser,
    runId,
    baseURL,
  }) => {
    test.setTimeout(300_000);
    const { fixture, directorPage, creator } = await seedAndSignIn(browser, runId, baseURL);
    const templateName = `Recovery ${runId}`;
    await saveNewTemplate(directorPage, fixture.source.code, templateName);
    await programRailTemplateStub({ imports: { commitThenDisconnect: true } });

    const otherPage = await creator.newPage();
    const codename = `Project Recovered ${runId}`;
    await runGate0(otherPage, {
      codename,
      leadName: fixture.leadName,
      templateName,
      submitTwice: true,
    });
    const code = await landedDealCode(otherPage);

    const imports = await railTemplateStubCalls('import');
    expect(imports, 'the import was not retried after the lost response').toHaveLength(2);
    expect(
      imports[1].requestId,
      'the retry did not replay the request id the first attempt was admitted under',
    ).toBe(imports[0].requestId);

    const deals = await creator.request.get('/api/v1/deals');
    expect(deals.ok(), await deals.text()).toBeTruthy();
    const body = (await deals.json()) as { deals: Array<{ codename: string; code: string }> };
    expect(
      body.deals.filter((deal) => deal.codename === codename).map((deal) => deal.code),
      'a retried mandate created more than one deal',
    ).toEqual([code]);
  });

  test('an admitted creation keeps the revision it captured when the rail is replaced', async ({
    browser,
    runId,
    baseURL,
  }) => {
    test.setTimeout(300_000);
    const { fixture, directorPage, director, creator } = await seedAndSignIn(
      browser,
      runId,
      baseURL,
    );
    const templateName = `Race ${runId}`;
    await saveNewTemplate(directorPage, fixture.source.code, templateName);
    const first = await namedTemplate(director.request, templateName);

    await programRailTemplateStub({ imports: { commitThenDisconnect: true } });
    const requestId = randomUUID();
    const admitted = await creator.request.post('/api/v1/deals', {
      data: {
        codename: `Project Admitted ${runId}`,
        targetCompanyId: fixture.leadCompanyId,
        conflictsAttestation: {
          approvedBy: CONFLICTS_APPROVER,
          approvedOn: new Date().toISOString().slice(0, 10),
        },
        requestId,
        railTemplate: { templateId: first.id, revisionId: first.revisionId },
      },
    });
    expect(admitted.status(), await admitted.text()).toBe(503);

    await removeSourceStep(director.request, fixture);
    await replaceTemplate(directorPage, fixture.source.code, templateName, 2);
    const second = await namedTemplate(director.request, templateName);
    expect(second.revisionId).not.toBe(first.revisionId);

    const resumed = await creator.request.post(`/api/v1/deals/template-creations/${requestId}`);
    expect(resumed.status(), await resumed.text()).toBe(200);
    const created = (await resumed.json()) as { deal: { id: string } };

    expect(await readDealTemplateRevision(created.deal.id)).toBe(first.revisionId);
    expect(catalogStepIds(await readDealSteps(created.deal.id))).toContain(
      fixture.secondRemovableStepId,
    );
  });

  test('refuses a second rail with the same name and a replacement from a stale revision', async ({
    browser,
    runId,
    baseURL,
  }) => {
    test.setTimeout(240_000);
    const { fixture, directorPage, director } = await seedAndSignIn(browser, runId, baseURL);
    const templateName = `Contested ${runId}`;
    await saveNewTemplate(directorPage, fixture.source.code, templateName);
    const first = await namedTemplate(director.request, templateName);

    const taken = await director.request.post('/api/v1/rail-templates', {
      data: {
        requestId: randomUUID(),
        sourceDealId: fixture.source.id,
        description: '',
        target: { kind: 'new', name: templateName },
      },
    });
    expect(taken.status()).toBe(409);
    expect(((await taken.json()) as { code: string }).code).toBe('name_taken');

    await removeSourceStep(director.request, fixture);
    await replaceTemplate(directorPage, fixture.source.code, templateName, 2);

    const stale = await director.request.post('/api/v1/rail-templates', {
      data: {
        requestId: randomUUID(),
        sourceDealId: fixture.source.id,
        description: '',
        target: {
          kind: 'replace',
          templateId: first.id,
          expectedRevisionId: first.revisionId,
        },
      },
    });
    expect(stale.status()).toBe(409);
    expect(((await stale.json()) as { code: string }).code).toBe('stale_template');
  });
});
