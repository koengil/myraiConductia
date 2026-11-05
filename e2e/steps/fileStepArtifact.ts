import fs from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';
import { openStepByDeepLink } from '../support/rail';
import { expectSingleComplianceInstrument } from '../support/selectors';
import { UPLOAD_STEP, UPLOAD_STEP_SEQ, manualDef } from './manualStepTarget';
import type { Step } from './types';

const FIXTURE = path.join(__dirname, '..', 'assets', 'e2e-fixture.pdf');
const UPLOAD_LABEL = manualDef(UPLOAD_STEP.id).uploadLabel as string;

export const fileStepArtifact: Step = {
  name: 'fileStepArtifact',

  async act(ctx) {
    ctx.state.stepDocumentName = `E2E Step Artifact ${ctx.runId}.pdf`;

    const focus = await openStepByDeepLink(
      ctx.page,
      ctx.state.dealCode as string,
      UPLOAD_STEP_SEQ,
      UPLOAD_STEP.title,
    );

    // The panel prints nothing while a file is in flight, so the POST is the
    // only signal that the filing finished before this step navigates away.
    const filed = ctx.page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().includes(`/steps/${UPLOAD_STEP.id}/dataroom/upload`),
    );
    await focus.getByLabel(UPLOAD_LABEL, { exact: true }).setInputFiles({
      name: ctx.state.stepDocumentName,
      mimeType: 'application/pdf',
      buffer: fs.readFileSync(FIXTURE),
    });
    expect((await filed).status()).toBe(201);
  },

  // The panel prints no receipt for a filed artifact, so the visible outcome is
  // the filing itself: the document under Deal Folder in the data room.
  async assertUi(ctx) {
    await ctx.page.goto(
      `/projects/${encodeURIComponent(ctx.state.dealCode as string)}/data-room`,
    );
    await expect(
      ctx.page
        .getByRole('region', { name: 'Deal Folder' })
        .getByText(ctx.state.stepDocumentName as string, { exact: true }),
    ).toBeVisible();
  },

  async verify(ctx) {
    const ref = ctx.state.dealCode as string;
    const { documents } = await ctx.evidence.listDocuments(ref);
    const doc = documents.find((d) => d.name === ctx.state.stepDocumentName);
    expect(doc, `no document named "${ctx.state.stepDocumentName}" on the deal`).toBeTruthy();
    expect(doc?.room, 'a step artifact is bank work product').toBe('internal');

    const me = await ctx.evidence.me();
    const upload = await ctx.evidence.expectAudit(ref, {
      action: 'upload',
      actorId: me.user.id,
      since: ctx.since,
    });
    const detail = upload.detail as { stepId?: string; fileName?: string } | null;
    expect(detail?.stepId).toBe(UPLOAD_STEP.id);
    expect(detail?.fileName).toBe(ctx.state.stepDocumentName);

    await expectSingleComplianceInstrument(ctx.page);
  },
};
