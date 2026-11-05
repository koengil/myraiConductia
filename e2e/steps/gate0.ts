import { expect } from '@playwright/test';
import type { JourneyContext } from './types';

const CONFLICTS_APPROVER = 'Pat Rivera';

/**
 * Drive the Gate 0 wizard to a created mandate. Shared by createDeal (no
 * chips) and createDealWithColleagueInvite (one chip), so the two journeys
 * cannot drift apart on how the gate is walked.
 *
 * Queued invitations are bank-internal by construction: postQueuedInvite fixes
 * companyRole to 'member' and the wizard's role list is the internal
 * allowlist (src/components/wizard/Gate0Wizard.tsx:169-215, 1461-1510). This
 * surface cannot produce an external identity, which is why the journey also
 * invites from Team (design D11).
 */
export async function runGate0Wizard(
  ctx: JourneyContext,
  opts: { inviteEmails?: string[]; leadQuery?: string; entryStep?: string } = {},
): Promise<void> {
  const codename = `Project E2E ${ctx.runId}`;

  await ctx.page.goto('/projects');
  await ctx.page.getByRole('button', { name: /Switch deal|Select a deal/ }).click();
  await ctx.page.getByRole('dialog', { name: 'Switch deal' }).getByRole('button', { name: 'New deal' }).click();

  const wizard = ctx.page.getByRole('dialog', { name: 'New mandate' });
  await expect(wizard).toBeVisible();

  // Sub-step 1 — the lead, then the code name.
  await wizard
    .getByPlaceholder('Search a registered lead…')
    .fill(opts.leadQuery ?? (ctx.state.leadName as string));
  await wizard
    .getByRole('listbox', { name: 'Matching companies' })
    .getByRole('option', { name: ctx.state.leadName as string })
    .click();
  // The code-name field seeds itself with an AI-suggested theme once the lead
  // is selected; wait for that async suggestion to land before typing ours, or
  // it overwrites the field a moment later.
  await expect(wizard.getByRole('button', { name: 'Regenerate' })).toBeEnabled();
  await wizard.getByLabel('Code name', { exact: true }).fill(codename);
  await wizard.getByRole('button', { name: 'Next' }).click();

  // Sub-step 2 — the senior-partner conflicts approval.
  await wizard.getByLabel('Approved by').fill(CONFLICTS_APPROVER);
  await wizard.getByLabel('Confirm the conflicts approval').check();
  await wizard.getByRole('button', { name: 'Next' }).click();

  // Sub-step 3 — team. Colleague invitations queue here as chips; the deal does
  // not exist yet, so they fire against POST /api/v1/invites only after create.
  for (const email of opts.inviteEmails ?? []) {
    await wizard.getByPlaceholder('colleague@bank.com').fill(email);
    await wizard.getByRole('button', { name: 'Check and add invitation' }).click();
    // The fixture address sits on the bank's seeded verified domain
    // (futureproofing.com), so preflight classifies it 'match' and no
    // confirmation is required. If the seed ever loses that domain the button
    // becomes "Confirm and add" instead; fail loudly rather than click blind.
    await expect(
      wizard.getByRole('button', { name: 'Confirm and add' }),
      `${email} unexpectedly required a domain confirmation at Gate 0; ` +
        'check the bank company still has a verified domain seeded.',
    ).toHaveCount(0);
    await expect(
      wizard.getByRole('list', { name: 'Queued invitations' }).getByText(email),
    ).toBeVisible();
  }
  await wizard.getByRole('button', { name: 'Next' }).click();

  // Sub-step 4 — notify compliance and management.
  await wizard.getByRole('button', { name: 'Next' }).click();

  // Sub-step 5 — the entry point. The default (04 · Relationship Pathing) is
  // kept unless the journey names a step, so the md-spine expectations
  // downstream do not change.
  if (opts.entryStep) {
    await wizard.getByLabel('Starting step').selectOption({ label: opts.entryStep });
  }
  await wizard.getByRole('button', { name: 'Create the mandate' }).click();
}
