import { expect, type Locator, type Page } from '@playwright/test';
import { MVP_DEAL_RAIL, orderedSteps, phaseForStep } from '@/lib/rail/dealRail';

/**
 * The three manual, non-live rail steps the ownership journey needs: one the
 * MD assigns to the member, one the MD keeps, one left unassigned. Manual
 * steps render ManualStepPanel (MANUAL_STEP_IDS and `!step.live`), which is
 * the only surface carrying Assigned to / Save progress / Mark step complete.
 */
export const MEMBER_STEP_ID = 'p1-s10';
export const MD_STEP_ID = 'p1-s11';
export const UNASSIGNED_STEP_ID = 'p1-s12';

export function railStepTitle(stepId: string): string {
  const step = orderedSteps().find((candidate) => candidate.id === stepId);
  if (!step) throw new Error(`no rail step is defined at ${stepId}`);
  return step.title;
}

/**
 * A step card on the board, by its state (open its phase first: openPhaseOf).
 * The step-card state a step reports through its accessible name
 * (STEP_STATE_LABEL in src/components/rail/stepState.ts).
 */
export function stepLocator(page: Page, stepId: string, state?: string): Locator {
  const title = escapeRegExp(railStepTitle(stepId));
  return page
    .getByRole('region', { name: 'Rail overview' })
    .getByRole('button', { name: new RegExp(`· ${title} · ${state ?? '.+'}$`) });
}

/** The zoom-out control names the phase the zoomed step sits in ("Zoom out to Preparation"). */
export const ZOOM_OUT = /^Zoom out to [A-Z][a-z]+$/;

/** The zoomed step's own heading (its name, e.g. "Relationship Pathing"): it changes when the zoom moves. */
export function zoomedStepHeading(page: Page): Locator {
  return page.getByRole('region', { name: 'Step detail' }).getByRole('heading', { level: 2 }).first();
}

/**
 * The rail opens zoomed out on its board; zoom into the deal's current step
 * from the header and return the step detail.
 */
export async function zoomIntoCurrentStep(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Open current step' }).click();
  const detail = page.getByRole('region', { name: 'Step detail' });
  await expect(detail).toBeVisible();
  return detail;
}

/**
 * Land on a step through its `?step=<seq>` deep link (the link a Conductor
 * Center task row carries) and return the step detail. The link opens from a
 * blank page so it always arrives as a new history entry: a goto to the URL
 * the page already shows is a reload of that entry, and a reload of the
 * rail's own zoom entry opens the board, not the step (zoomHistory.ts).
 */
export async function openStepByDeepLink(
  page: Page,
  dealCode: string,
  seq: number,
  title: string,
): Promise<Locator> {
  await page.goto('about:blank');
  await page.goto(`/projects/${encodeURIComponent(dealCode)}/rail?step=${seq}`);
  const detail = page.getByRole('region', { name: 'Step detail' });
  await expect(
    detail.getByRole('heading', { name: title }),
    `the ?step=${seq} deep link did not open ${title}`,
  ).toBeVisible();
  return detail;
}

/** Open a phase on the board when it is closed, so its step cards show. */
export async function openPhase(page: Page, phaseName: string): Promise<void> {
  const toggle = page
    .getByRole('region', { name: 'Rail overview' })
    .getByRole('button', { name: phaseName, exact: true });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  // A done run at the top of the column folds into one "N done" row.
  const column = page.locator('[data-phase-column]').filter({ has: toggle });
  const fold = column.getByRole('button', { name: /^\d+ done$/, expanded: false });
  if ((await fold.count()) > 0) await fold.click();
}

/** Open the phase a catalog step sits in. */
export async function openPhaseOf(page: Page, stepId: string): Promise<void> {
  const phase = phaseForStep(stepId, MVP_DEAL_RAIL);
  if (phase) await openPhase(page, phase.name);
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Open a step from the board, which zooms the rail into it, and return the
 * manual work panel. Returns a locator rather than asserting on the panel's
 * contents so each step owns its own claims.
 */
export async function openStepFromBoard(
  page: Page,
  dealCode: string,
  stepId: string,
): Promise<Locator> {
  const title = railStepTitle(stepId);
  await page.goto(`/projects/${encodeURIComponent(dealCode)}/rail`);

  const overview = page.getByRole('region', { name: 'Rail overview' });
  await expect(overview).toBeVisible();
  await openPhaseOf(page, stepId);
  await overview.getByRole('button', { name: new RegExp(`· ${escapeRegExp(title)} ·`) }).click();

  const focus = page.getByRole('region', { name: 'Step detail' });
  await expect(focus).toBeVisible();
  await expect(focus.getByRole('heading', { name: new RegExp(escapeRegExp(title)) })).toBeVisible();

  const panel = focus.getByRole('region', { name: 'Manual step work' });
  await expect(panel).toBeVisible();
  await expect(
    panel.getByText('Enable the platform API to assign, save, and complete this step'),
    'gate0_api_create is off, so the step panel has no assign, save or complete controls',
  ).toHaveCount(0);
  await expect(panel.getByRole('status'), 'the step panel never finished loading').toHaveCount(0);
  return panel;
}

/** The copy that names the prompt after a saved rail edit (add, remove). */
export const RAIL_EDIT_PROMPT_SCOPE = 'This changes the rail for everyone on this deal.';
/** The copy on the prompt after a Preview move (kept in this browser, never saved). */
export const RAIL_MOVE_PROMPT_SCOPE =
  'Only you see this order. It is kept in this browser and is not saved to the deal.';

/**
 * The prompt someone with rail editing rights sees after adding, removing or
 * moving a step. Journeys that are not about it answer the default ("Apply to
 * this deal" after an add or remove, "Keep in this browser" after a move) and
 * carry on.
 */
export async function answerRailEditPrompt(page: Page, timeout = 30_000): Promise<void> {
  const prompt = page
    .getByRole('dialog')
    .filter({ hasText: new RegExp(`${escapeRegExp(RAIL_EDIT_PROMPT_SCOPE)}|${escapeRegExp(RAIL_MOVE_PROMPT_SCOPE)}`) });
  await expect(prompt).toBeVisible({ timeout });
  await prompt.getByRole('button', { name: /^(Apply to this deal|Keep in this browser)$/ }).click();
  await expect(prompt).toHaveCount(0);
}

/** Zooms into a board card: Move to…, Assign… and Remove live in step detail. */
export async function zoomIntoCard(page: Page, card: Locator): Promise<Locator> {
  await card.getByRole('button', { name: /^Step \d+ · / }).click();
  const panel = page.getByRole('region', { name: 'Step detail' });
  await expect(panel).toBeVisible();
  return panel;
}

/** Back to the board from step detail. */
export async function zoomOutToBoard(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Zoom out to / }).click();
  await expect(page.getByRole('region', { name: 'Rail overview' })).toBeVisible();
}

/**
 * Remove from step detail: "Remove", then its inline "Remove step". Returns
 * the detail panel, so a journey can check the confirmation or answer the
 * edit prompt that follows. Stays in step detail: zoomOutToBoard goes back.
 */
export async function removeStepFromCard(page: Page, card: Locator, confirm = true): Promise<Locator> {
  const panel = await zoomIntoCard(page, card);
  await panel.getByRole('button', { name: 'Remove', exact: true }).click();
  if (confirm) await panel.getByRole('button', { name: 'Remove step' }).click();
  return panel;
}

/**
 * The MD hands a step to someone from step detail: "Assign…", choose the
 * person, confirm. The steps PATCH underneath. Returns once the dialog has closed.
 */
export async function assignStepFromDetail(
  page: Page,
  panel: Locator,
  personName: string,
): Promise<void> {
  await panel.getByRole('button', { name: 'Assign…' }).click();
  const dialog = page.getByRole('dialog').filter({ hasText: 'Choose who owns this step on the deal.' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('radio', { name: new RegExp(`^${escapeRegExp(personName)}`) }).check();
  await dialog.getByRole('button', { name: `Assign to ${personName}` }).click();
  await expect(dialog).toBeHidden();
}

/**
 * Add step always opens with a spot for the step (after the deal's current
 * step, or the step whose plus was used), shown as one line once the draft is
 * read: "Adds after: … · Change". Change opens the Phase and Position
 * choices; this picks a position value ("phase_start", "phase_end",
 * "after:<id>", "before:<id>").
 */
export async function chooseAddStepPosition(dialog: Locator, value: string): Promise<void> {
  await expect(dialog.getByTestId('placement-summary')).toBeVisible({ timeout: 30_000 });
  await dialog.getByRole('button', { name: 'Change where this step goes' }).click();
  await dialog.getByLabel('Position').selectOption(value);
}

/**
 * A step's draft button names what it makes ("Draft the teaser", "Draft with
 * the Weekly board memo skill"); the step detail's opener adds "…".
 */
export const DRAFT_BUTTON = /^Draft (the |with the ).+[^…]$/;

/**
 * After "Save skill and add step" the rail lands on the board with the new
 * step's card highlighted (and movable with Edit rail, through the reorder Preview).
 */
export function addedStepCard(page: Page): Locator {
  return page.getByRole('region', { name: 'Rail overview' }).locator('[data-highlight="new"]');
}

/**
 * A Preview move from step detail: "Move to…", the first place the dialog
 * offers, then "Move step". Nothing is sent; the new order is held in this
 * browser. Stays in step detail: zoomOutToBoard goes back.
 */
export async function moveStepFromCard(page: Page, stepId: string): Promise<void> {
  const title = railStepTitle(stepId);
  await page.getByRole('button', { name: 'Edit rail' }).click();
  await page
    .getByRole('region', { name: 'Rail overview' })
    .getByRole('button', { name: new RegExp(`· ${escapeRegExp(title)} · `) })
    .click();
  const panel = page.getByRole('region', { name: 'Step detail' });
  await panel.getByRole('button', { name: 'Move to…' }).click();
  const dialog = page.getByRole('dialog', { name: title, exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('radio').first().check();
  await dialog.getByRole('button', { name: 'Move step' }).click();
  await expect(dialog).toHaveCount(0);
}

/** The board's mark on a step moved in the reorder Preview. */
export const MOVED_IN_BROWSER = 'Moved in this browser';
