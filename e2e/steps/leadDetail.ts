import { expect, type Locator } from '@playwright/test';
import type { JourneyContext } from './types';

export async function expandLead(ctx: JourneyContext): Promise<void> {
  const leadName = ctx.state.leadName as string;
  const toggle = ctx.page
    .getByRole('region', { name: 'Registered leads' })
    .getByRole('button', { name: leadName, exact: true });
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
}

export function relationshipRow(ctx: JourneyContext, personName: string): Locator {
  return ctx.page.getByRole('button', { name: `Remove relationship ${personName}` });
}

export function stakeholderRow(ctx: JourneyContext, name: string): Locator {
  return ctx.page.getByRole('button', { name: `Remove stakeholder ${name}` });
}
