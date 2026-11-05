import fs from 'node:fs';
import path from 'node:path';
import { openEmailSignIn } from '../support/signIn';
import { MD_EMAIL } from '../auth/session';
import { newCollectedContext } from '../support/cspViolations';
import { expect, test } from '../support/fixtures';
import { zoomIntoCurrentStep } from '../support/rail';
import { createRailDeal } from '../support/railDealFixture';
import { RELATIONSHIP_PATHING_STEP_ID } from '@/lib/rail/dealRail';

/**
 * The surfaces the owner named, walked through the UI under the enforced
 * Content-Security-Policy (R10). The point is the real page under the real
 * header, so nothing is mocked and nothing is asserted about the policy text:
 * the fixture fails the test on any `securitypolicyviolation` recorded in any
 * context this test opened, and the sign-in step is the one browser call to the
 * Supabase origin that connect-src allows, so it proves that allowance too.
 *
 * Each step asserts only that its page rendered. Not exercised on the hermetic
 * tier, and covered by the smoke checklist instead (docs/04-operations/csp-runbook.md):
 * real Box, real Ignatious output, a populated inbox, the flag-off data-room
 * iframe, /dev-api, and the Google and Microsoft sign-in buttons (the demo
 * signs in with a password).
 *
 * Hermetic only: it needs the seeded discovery corpus and the local storage
 * provider, and it writes a deal.
 */
test.skip(Boolean(process.env.E2E_BASE_URL), 'needs the fixture corpus and writes a deal');

const FIXTURE = path.join(__dirname, '..', 'assets', 'e2e-fixture.pdf');
const DESTINATION = '00. Received from Client';

const BENIGN_BRIEF = [
  'Lead with the shared board seat. The introducer is the strongest path.',
  '',
  'Source: [SEC filing](https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000000000)',
].join('\n');

test('the main surfaces render under the enforced policy with zero violations', async ({
  browser,
  baseURL,
  evidence,
  runId,
}) => {
  const password = process.env.SEED_PASSWORD;
  expect(password, 'SEED_PASSWORD is the seeded accounts\' password').toBeTruthy();

  // A fresh, signed-out context: the sign-in page is the first surface, and it
  // signs in for real so the Supabase auth call goes through connect-src.
  const context = await newCollectedContext(browser, {
    baseURL,
    storageState: { cookies: [], origins: [] },
  });
  const page = await context.newPage();

  await test.step('sign-in: the password form signs in', async () => {
    await page.goto('/sign-in');
    await openEmailSignIn(page);
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled();
    await page.getByLabel('Email').fill(MD_EMAIL);
    await page.getByPlaceholder('Your password').fill(password!);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(/\/projects$/);
  });

  await test.step('project picker', async () => {
    await page.goto('/projects');
    await expect(page.getByRole('main').or(page.locator('main')).first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Discovery' }).first()).toBeVisible();
  });

  const deal = await createRailDeal(evidence.request, { runId, entryStepSeq: 8 });
  const project = `/projects/${encodeURIComponent(deal.code)}`;
  const seeded = await evidence.request.patch(
    `/api/v1/deals/${encodeURIComponent(deal.id)}/steps/${RELATIONSHIP_PATHING_STEP_ID}`,
    { data: { work: { pathing_brief: BENIGN_BRIEF } } },
  );
  expect(seeded.ok(), await seeded.text()).toBeTruthy();

  await test.step('deal rail: Markdown renders and the link panel opens and closes', async () => {
    await page.goto(`${project}/rail`);
    await zoomIntoCurrentStep(page);
    const brief = page.getByRole('region', { name: 'Skill brief' });
    await expect(brief).toBeVisible();
    await brief.locator('[data-md-external-link]').click();
    const panel = page.getByRole('dialog', { name: /^This link opens / });
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId('external-link-href')).toContainText('sec.gov');
    await panel.getByRole('button', { name: 'Cancel' }).click();
    await expect(panel).toHaveCount(0);
  });

  await test.step('deal folder: a document uploads through the UI', async () => {
    await page.goto(`${project}/deal-folder`);
    await page.getByRole('combobox', { name: 'Deal folder' }).selectOption({ label: DESTINATION });
    await page.getByLabel('File', { exact: true }).setInputFiles({
      name: `E2E CSP Walk ${runId}.pdf`,
      mimeType: 'application/pdf',
      buffer: fs.readFileSync(FIXTURE),
    });
    await page.getByRole('button', { name: 'Upload' }).click();
    await expect(
      page.getByRole('complementary', { name: 'Folder tree' }).getByText('1 document', { exact: true }),
    ).toBeVisible();
  });

  await test.step('data room', async () => {
    await page.goto(`${project}/data-room`);
    await expect(page.getByRole('region', { name: 'Data room' })).toBeVisible();
  });

  await test.step('discovery: the list and the first candidate', async () => {
    await page.goto('/discovery');
    await expect(page.getByRole('heading', { level: 1, name: 'Proposed deals' })).toBeVisible();
    const first = page.locator('[data-candidate-id]').first();
    await expect(first).toBeVisible();
    const name = (await first.getByRole('heading').first().textContent())?.trim() ?? '';
    await first.getByRole('link').first().click();
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Evidence' })).toBeVisible();
  });

  await test.step('mail: the composer opens (nothing is sent)', async () => {
    await page.goto(`${project}/mail`);
    await page.getByRole('button', { name: 'New message' }).click();
    await expect(page.getByRole('region', { name: 'Compose email' })).toBeVisible();
  });

  await test.step('skills: the library renders', async () => {
    await page.goto(`${project}/skills`);
    await expect(page.getByRole('region', { name: 'Skills' })).toBeVisible();
  });

  await test.step('skill builder: the dialog opens from the rail', async () => {
    await page.goto(`${project}/rail`);
    await page.getByRole('button', { name: 'Add new step' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Skill builder' });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });

  await test.step('profile', async () => {
    await page.goto('/profile');
    await expect(page.getByRole('button', { name: 'Edit full name' })).toBeVisible();
  });

  // The fixture asserts zero violations across `context` at teardown.
});
