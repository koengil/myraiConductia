import { expect } from '@playwright/test';
import { expectSingleComplianceInstrument } from '../support/selectors';
import { requireEvidence, requirePage } from './types';
import type { Step } from './types';

export const assertExternalRoomWall: Step = {
  name: 'assertExternalRoomWall',

  async act(ctx) {
    const page = requirePage(ctx.externalPage, 'assertExternalRoomWall');
    await page.goto(`/projects/${encodeURIComponent(ctx.state.dealCode as string)}/data-room`);
  },

  async assertUi(ctx) {
    const page = requirePage(ctx.externalPage, 'assertExternalRoomWall');
    const clientRoom = page.getByRole('region', { name: 'Client documents' });

    await expect(
      clientRoom.getByText(ctx.state.documentName as string, { exact: true }),
    ).toBeVisible();
    await expect(clientRoom.getByRole('link', { name: 'Download' })).toHaveCount(1);

    await expect(
      page.getByRole('region', { name: 'Deal Folder' }),
      'the counterparty is shown the internal Deal Folder section',
    ).toHaveCount(0);
    await expect(
      page.getByText(ctx.state.dealFolderDocumentName as string, { exact: true }),
      'the counterparty is shown a Deal Folder filing',
    ).toHaveCount(0);

    await page.goto(`/projects/${encodeURIComponent(ctx.state.dealCode as string)}/deal-folder`);
    await expect(page).toHaveURL(new RegExp(`/projects/${ctx.state.dealCode}/?$`));
  },

  async verify(ctx) {
    const page = requirePage(ctx.externalPage, 'assertExternalRoomWall');
    const evidence = requireEvidence(ctx.externalEvidence, 'assertExternalRoomWall');
    const ref = ctx.state.dealCode as string;

    const { documents } = await evidence.listDocuments(ref);
    expect(
      documents.map((doc) => doc.name),
      'the counterparty is not served the client document',
    ).toContain(ctx.state.documentName);
    expect(
      documents.map((doc) => doc.name),
      'the internal filing is served to the counterparty',
    ).not.toContain(ctx.state.dealFolderDocumentName);
    expect(
      documents.map((doc) => doc.room),
      'an internal-room row reached the counterparty',
    ).not.toContain('internal');

    const probe = await evidence.request.get(
      `/api/v1/deals/${encodeURIComponent(ref)}/documents/${ctx.state.dealFolderDocumentId}/download`,
    );
    expect(probe.status(), 'the counterparty can pull the internal file by id').toBe(404);

    await expectSingleComplianceInstrument(page);
  },
};
