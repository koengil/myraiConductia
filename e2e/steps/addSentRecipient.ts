import {expect} from '@playwright/test';
import {expectInvite} from '../support/invites';
import type {Step} from './types';

/** Uses the preceding journey's accepted external director, so a member invite
 * is eligible without relaxing the company's first-director requirement. */
export const addSentRecipient:Step={
 name:'addSentRecipient',
 async act(ctx){
  const email=`zz-test-recipient-${ctx.runId}@e2e-external.test`;
  ctx.state.recipientEmail=email;
  await ctx.page.goto(`/projects/${ctx.state.dealCode}/mail`);
  await ctx.page.getByRole('button',{name:'New message'}).click();
  const composer=ctx.page.getByRole('region',{name:'Compose email'});
  // D81: an outsider not on the deal is challenged in To and in Cc alike.
  await composer.getByLabel('To',{exact:true}).fill(`zz-test-addressee-${ctx.runId}@e2e-external.test`);
  await composer.getByRole('button',{name:'Cc',exact:true}).click();
  await composer.getByLabel('Cc',{exact:true}).fill(email);
  await composer.getByPlaceholder('Subject').fill(`ZZ TEST recipient ${ctx.runId}`);
  await composer.getByRole('textbox',{name:'Message'}).fill('The room opens Monday.');
  await composer.getByRole('button',{name:'Send',exact:true}).click();
  const review=ctx.page.getByRole('dialog',{name:'Review email recipients'});
  await expect(review).toContainText('EXTERNAL NON-DEAL ASSOCIATED PARTY');
  // Issue #378: approving an outsider new to the deal sends and makes them a known recipient.
  await review.getByRole('button',{name:/^Send anyway and add as known recipients?$/}).click();
  // An outside address is given access from the Data Room: the link carries the address there.
  const addLink=ctx.page.getByRole('link',{name:`Give ${email} data room access`});
  await expect(addLink).toBeVisible();
  // The To addressee was challenged too, so they are offered access as well.
  await expect(ctx.page.getByRole('link',{name:`Give zz-test-addressee-${ctx.runId}@e2e-external.test data room access`})).toBeVisible();
  await addLink.click();
  await expect(ctx.page).toHaveURL(new RegExp(`/projects/${ctx.state.dealCode}/data-room`));
  const modal=ctx.page.getByRole('dialog',{name:'Give data room access'});
  await expect(modal.getByLabel('Email',{exact:true})).toHaveValue(email);
  // Each select sits inside its label, so a label's text carries the options:
  // read the selects by role and accessible name, which is the label alone.
  await modal.getByRole('combobox',{name:'Company',exact:true}).selectOption({label:ctx.state.leadName!});
  await modal.getByRole('combobox',{name:'Deal relationship',exact:true}).selectOption('counterparty');
  await expect(modal.getByRole('combobox',{name:'Role',exact:true})).toHaveValue('member');
  await expect(modal.getByRole('combobox',{name:'Access up to',exact:true})).toHaveValue('0');
  await modal.getByRole('button',{name:'Check and send invite'}).click();
  await expect(modal.getByRole('alert').filter({hasText:'no verified email domain'})).toBeVisible();
  await modal.getByRole('button',{name:'Confirm and send'}).click();
  await expect(modal.getByText(`Invite pending for ${email}`)).toBeVisible();
  await modal.getByRole('button',{name:'Done'}).click();
 },
 async assertUi(ctx){
  // The delivered invitation establishes the relationship, but a counterparty
  // still requires a fresh confirmation on the next email.
  await ctx.page.goto(`/projects/${ctx.state.dealCode}/mail`);
  await ctx.page.getByRole('button',{name:'New message'}).click();
  const composer=ctx.page.getByRole('region',{name:'Compose email'});
  await composer.getByLabel('To',{exact:true}).fill(ctx.state.recipientEmail!);
  await composer.getByPlaceholder('Subject').fill('ZZ TEST subsequent send');
  await composer.getByRole('textbox',{name:'Message'}).fill('The agenda follows tomorrow.');
  await composer.getByRole('button',{name:'Send',exact:true}).click();
  const review=ctx.page.getByRole('dialog',{name:'Review email recipients'});
  await expect(review).toContainText('Counterparty and/or Counterparty Advisor');
  await review.getByRole('button',{name:'Back to editing'}).click();
 },
 async verify(ctx){
  const invite=await expectInvite(ctx.evidence.request,ctx.state.dealCode!,ctx.state.recipientEmail!,{status:'pending',deliveryStatus:'sent'});
  expect(invite.companyRole).toBe('member');expect(invite.dealRole).toBe('seller');
  const result=await ctx.evidence.request.post(`/api/v1/deals/${ctx.state.dealCode}/recipient-check`,{data:{bcc:[ctx.state.recipientEmail],to:[],cc:[]}});
  expect(result.status()).toBe(200);expect((await result.json()).recipients[0]).toMatchObject({relationship:'counterparty',requiresConfirmation:true,field:'bcc'});
 }
};
