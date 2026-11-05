import path from 'node:path';
import { expect } from '@playwright/test';
import { expectSingleComplianceInstrument } from '../support/selectors';
import type { Step } from './types';

const FIXTURE = path.join(__dirname, '..', 'assets', 'e2e-fixture.pdf');

/**
 * Step 4 — the deal room. With platform_onboarding on this is the live
 * document store over GET/POST /api/v1/deals/{dealId}/documents; the server
 * walls rows per viewer and every upload is audited.
 */
export const uploadToDataRoom: Step = {
  name: 'uploadToDataRoom',

  async act(ctx) {
    ctx.state.documentName = `E2E Upload ${ctx.runId}.pdf`;

    await ctx.page.goto(
      `/projects/${encodeURIComponent(ctx.state.dealCode as string)}/data-room`,
    );

    const panel = ctx.page.getByRole('region', { name: 'Upload a document' });
    await expect(panel).toBeVisible();
    await panel.getByLabel('File').setInputFiles(FIXTURE);
    await panel.getByLabel('Name override (optional)').fill(ctx.state.documentName);
    await panel.getByRole('button', { name: 'Upload' }).click();
  },

  async assertUi(ctx) {
    await expect(
      ctx.page
        .getByRole('region', { name: 'Client documents' })
        .getByText(ctx.state.documentName as string, { exact: true }),
    ).toBeVisible();
  },

  async verify(ctx) {
    const ref = ctx.state.dealCode as string;
    const { documents } = await ctx.evidence.listDocuments(ref);
    const doc = documents.find((d) => d.name === ctx.state.documentName);
    expect(doc, `no document named "${ctx.state.documentName}" on the deal`).toBeTruthy();
    expect(doc?.hasFile, 'the document row carries no stored file').toBe(true);

    const me = await ctx.evidence.me();
    await ctx.evidence.expectAudit(ref, {
      action: 'upload',
      actorId: me.user.id,
      since: ctx.since,
    });

    await expectSingleComplianceInstrument(ctx.page);
  },
};
