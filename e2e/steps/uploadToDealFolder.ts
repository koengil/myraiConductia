import fs from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';
import { fileTypeLabel, formatBytes } from '@/lib/dataroom/tree';
import { expectSingleComplianceInstrument } from '../support/selectors';
import type { Step } from './types';

const FIXTURE = path.join(__dirname, '..', 'assets', 'e2e-fixture.pdf');
const DESTINATION = '00. Received from Client';

export const uploadToDealFolder: Step = {
  name: 'uploadToDealFolder',

  async act(ctx) {
    ctx.state.dealFolderDocumentName = `E2E Deal Folder ${ctx.runId}.pdf`;

    await ctx.page.goto(
      `/projects/${encodeURIComponent(ctx.state.dealCode as string)}/deal-folder`,
    );

    await ctx.page
      .getByRole('combobox', { name: 'Deal folder' })
      .selectOption({ label: DESTINATION });
    await ctx.page.getByLabel('File', { exact: true }).setInputFiles({
      name: ctx.state.dealFolderDocumentName,
      mimeType: 'application/pdf',
      buffer: fs.readFileSync(FIXTURE),
    });
    await ctx.page.getByRole('button', { name: 'Upload' }).click();
  },

  async assertUi(ctx) {
    const name = ctx.state.dealFolderDocumentName as string;

    // The tree collapses itself whenever the document list is refetched, so
    // the filing has to have landed before the folder is opened.
    await expect(
      ctx.page.getByRole('complementary', { name: 'Folder tree' }).getByText('1 document', { exact: true }),
    ).toBeVisible();

    await ctx.page
      .getByRole('button', { name: new RegExp(`^${DESTINATION.replace(/\./g, '\\.')}`) })
      .click();

    const file = ctx.page.getByRole('button', { name: new RegExp(`^${name} `) });
    await expect(file).toBeVisible();
    await file.click();

    const size = fs.statSync(FIXTURE).size;
    await expect(
      ctx.page.getByText(`${fileTypeLabel('pdf')} · ${formatBytes(size)}`).first(),
    ).toBeVisible();
  },

  async verify(ctx) {
    const ref = ctx.state.dealCode as string;
    const name = ctx.state.dealFolderDocumentName as string;

    const { documents } = await ctx.evidence.listDocuments(ref);
    const doc = documents.find((d) => d.name === name);
    expect(doc, `no document named "${name}" on the deal`).toBeTruthy();
    expect(doc?.room, 'a Deal Folder upload must land in the internal room').toBe('internal');
    expect(doc?.folder).toBe('received-from-client');
    expect(doc?.sizeBytes).toBe(fs.statSync(FIXTURE).size);
    expect(doc?.hasFile, 'the document row carries no stored file').toBe(true);
    ctx.state.dealFolderDocumentId = doc?.id;

    const me = await ctx.evidence.me();
    await ctx.evidence.expectAudit(ref, {
      action: 'upload',
      actorId: me.user.id,
      since: ctx.since,
    });

    await expectSingleComplianceInstrument(ctx.page);
  },
};
