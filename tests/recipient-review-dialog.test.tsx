import * as React from 'react';
import { afterEach,expect,it,vi } from 'vitest';
import { cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react';
import { RecipientReviewDialog } from '@/components/mail/RecipientReviewDialog';
import { ExternalSendConfirmDialog } from '@/components/mail/ExternalSendConfirmDialog';
import { RecipientRelationshipList } from '@/components/mail/RecipientRelationshipList';
import type { RecipientDecision } from '@/lib/mail/recipientReview';
afterEach(cleanup);
const recipients:RecipientDecision[]=[{field:'bcc',email:'zz-test@buyer.test',boundary:'external',relationship:'counterparty',requiresConfirmation:true,reason:'counterparty'}];
it('explains counterparties, removes from the original field, and explicitly approves',()=>{
 const remove=vi.fn(),approve=vi.fn(),cancel=vi.fn();
 render(<RecipientReviewDialog open recipients={recipients} busy={false} onRemove={remove} onApprove={approve} onCancel={cancel}/>);
 expect(screen.getByRole('dialog')).toHaveTextContent(/Counterparty/);
 fireEvent.click(screen.getByRole('button',{name:/remove.*zz-test/i}));expect(remove).toHaveBeenCalledWith('bcc','zz-test@buyer.test');
 fireEvent.click(screen.getByRole('button',{name:'Approve recipients and continue'}));expect(approve).toHaveBeenCalledOnce();
 fireEvent.keyDown(screen.getByRole('dialog'),{key:'Escape'});expect(cancel).toHaveBeenCalledOnce();
});
it('prevents repeated submission while busy',()=>{render(<RecipientReviewDialog open recipients={recipients} busy onRemove={vi.fn()} onApprove={vi.fn()} onCancel={vi.fn()}/>);expect(screen.getByRole('button',{name:'Approve recipients and continue'})).toBeDisabled();});
it('shows accessible relationship labels as well as external color',()=>{render(<RecipientRelationshipList recipients={[{...recipients[0],relationship:'client_advisor',requiresConfirmation:false,reason:null}]} onRemove={vi.fn()}/>);expect(screen.getByText(/Client advisor/)).toBeInTheDocument();expect(screen.getByText(/Bcc/)).toBeInTheDocument();});
it('uses prominent external warning only for actual external unassociated recipients',()=>{
 const view=render(<RecipientReviewDialog open recipients={[{...recipients[0],relationship:'unassociated',reason:'not_on_deal'}]} busy={false} onRemove={vi.fn()} onApprove={vi.fn()} onCancel={vi.fn()}/>);
 expect(screen.getByText('EXTERNAL NON-DEAL ASSOCIATED PARTY COPIED ON THIS EMAIL. PLEASE APPROVE.')).toBeInTheDocument();
 view.rerender(<RecipientReviewDialog open recipients={[{...recipients[0],boundary:'internal',relationship:'unassociated',reason:'not_on_deal'}]} busy={false} onRemove={vi.fn()} onApprove={vi.fn()} onCancel={vi.fn()}/>);
 expect(screen.queryByText(/EXTERNAL NON-DEAL/)).not.toBeInTheDocument();
});
it('does not raise the external banner for an external recipient whose relationship is confirmed',()=>{
 render(<RecipientReviewDialog open recipients={[recipients[0],{field:'to',email:'cfo@client.test',boundary:'external',relationship:'client',requiresConfirmation:false,reason:null}]} busy={false} onRemove={vi.fn()} onApprove={vi.fn()} onCancel={vi.fn()}/>);
 expect(screen.queryByText(/EXTERNAL NON-DEAL/)).not.toBeInTheDocument();
 expect(screen.getByText(/Counterparty and\/or Counterparty Advisor/)).toBeInTheDocument();
});
it('colours each chip by Storm\'s rule and names it in text: internal, external (orange), needs approval (red) (Issues #378, #429)',()=>{
 render(<RecipientRelationshipList recipients={[
  {field:'to',email:'banker@bank.test',boundary:'internal',relationship:'bank_team',requiresConfirmation:false,reason:null},
  {field:'cc',email:'cfo@client.test',boundary:'external',relationship:'client',requiresConfirmation:false,reason:null},
  {field:'cc',email:'old@outside.test',boundary:'external',relationship:'unassociated',knownToDeal:true,requiresConfirmation:false,reason:null},
  {field:'cc',email:'new@outside.test',boundary:'external',relationship:'unassociated',requiresConfirmation:true,reason:'not_on_deal'},
 ]} onRemove={vi.fn()}/>);
 const chip=(email:string)=>screen.getByText(new RegExp(email.replace(/\./g,'\\.'))).closest('li')!;
 expect(chip('banker@bank.test')).toHaveAttribute('data-marking','internal');
 expect(chip('banker@bank.test')).toHaveTextContent('Internal');
 expect(chip('banker@bank.test').className).not.toMatch(/negative|hold|positive/);
 expect(chip('cfo@client.test')).toHaveAttribute('data-marking','external');
 expect(chip('cfo@client.test').className).toContain('--hold-fill');
 expect(chip('old@outside.test')).toHaveAttribute('data-marking','external');
 expect(chip('old@outside.test')).toHaveTextContent('Emailed on this deal before');
 expect(chip('new@outside.test')).toHaveAttribute('data-marking','second_approval');
 expect(chip('new@outside.test')).toHaveTextContent('Needs approval');
 expect(chip('new@outside.test').className).toContain('--negative-fill');
});
it('does not claim history on a red chip: a colleague off the deal stays Needs approval only (Issue #378 review)',()=>{
 render(<RecipientRelationshipList recipients={[
  {field:'cc',email:'colleague@bank.test',boundary:'internal',relationship:'unassociated',knownToDeal:true,requiresConfirmation:true,reason:'not_on_deal'},
 ]} onRemove={vi.fn()}/>);
 const chip=screen.getByText(/colleague@bank\.test/).closest('li')!;
 expect(chip).toHaveTextContent('Needs approval');
 expect(chip).not.toHaveTextContent('Emailed on this deal before');
});
it('offers Storm\'s three choices for an outsider new to the deal: send and add as known, remove, or go back (Issue #378)',()=>{
 const remove=vi.fn(),approve=vi.fn(),cancel=vi.fn();
 render(<RecipientReviewDialog open recipients={[{field:'cc',email:'new@outside.test',boundary:'external',relationship:'unassociated',requiresConfirmation:true,reason:'not_on_deal'}]} busy={false} onRemove={remove} onApprove={approve} onCancel={cancel}/>);
 expect(screen.getByText(/Sending adds new@outside\.test as a known recipient for this project/)).toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'Send anyway and add as known recipient'}));expect(approve).toHaveBeenCalledOnce();
 fireEvent.click(screen.getByRole('button',{name:/remove new@outside\.test/i}));expect(remove).toHaveBeenCalledWith('cc','new@outside.test');
 fireEvent.click(screen.getByRole('button',{name:'Back to editing'}));expect(cancel).toHaveBeenCalledOnce();
});
it('does not promise a known recipient for a counterparty, who is asked every time',()=>{
 render(<RecipientReviewDialog open recipients={recipients} busy={false} onRemove={vi.fn()} onApprove={vi.fn()} onCancel={vi.fn()}/>);
 expect(screen.queryByText(/known recipient/)).not.toBeInTheDocument();
 expect(screen.getByRole('button',{name:'Approve recipients and continue'})).toBeInTheDocument();
});
it('offers Remove only next to a flagged recipient, not the deal team or a confirmed relationship',()=>{
 render(<RecipientRelationshipList recipients={[
  recipients[0],
  {field:'to',email:'banker@bank.test',boundary:'internal',relationship:'bank_team',requiresConfirmation:false,reason:null},
  {field:'cc',email:'cfo@client.test',boundary:'external',relationship:'client',requiresConfirmation:false,reason:null},
 ]} onRemove={vi.fn()}/>);
 expect(screen.getByRole('button',{name:/remove zz-test@buyer\.test/i})).toBeInTheDocument();
 expect(screen.queryByRole('button',{name:/remove banker@bank\.test/i})).not.toBeInTheDocument();
 expect(screen.queryByRole('button',{name:/remove cfo@client\.test/i})).not.toBeInTheDocument();
});

// The overlay Dialog has no busy prop (Foundation-owned), so while a send is in flight the close button stays
// enabled and does nothing; Escape and Remove are inert too.
it('ignores Escape, the close button and Remove while a send is in flight',()=>{
 const cancel=vi.fn(),remove=vi.fn();
 render(<RecipientReviewDialog open recipients={recipients} busy onRemove={remove} onApprove={vi.fn()} onCancel={cancel}/>);
 fireEvent.keyDown(screen.getByRole('dialog'),{key:'Escape'});
 fireEvent.click(screen.getByRole('button',{name:'Close'}));
 fireEvent.click(screen.getByRole('button',{name:/remove.*zz-test/i}));
 expect(cancel).not.toHaveBeenCalled();expect(remove).not.toHaveBeenCalled();
 expect(screen.getByRole('dialog',{name:'Review email recipients'})).toBeInTheDocument();
});
it('a click on the scrim does not close the recipient review',async()=>{
 const cancel=vi.fn();
 render(<RecipientReviewDialog open recipients={recipients} busy={false} onRemove={vi.fn()} onApprove={vi.fn()} onCancel={cancel}/>);
 const scrim=document.querySelector<HTMLElement>('[data-overlay-scrim]')!;
 fireEvent.mouseDown(scrim);fireEvent.click(scrim);
 expect(cancel).not.toHaveBeenCalled();
 expect(screen.getByRole('dialog',{name:'Review email recipients'})).toBeInTheDocument();
});
it('the external-send confirm ignores Escape and the close button while busy, and never closes on the scrim',()=>{
 const cancel=vi.fn();
 const view=render(<ExternalSendConfirmDialog open recipients={['cfo@client.test']} busy onConfirm={vi.fn()} onCancel={cancel}/>);
 fireEvent.keyDown(screen.getByRole('dialog'),{key:'Escape'});
 fireEvent.click(screen.getByRole('button',{name:'Close'}));
 expect(cancel).not.toHaveBeenCalled();
 view.rerender(<ExternalSendConfirmDialog open recipients={['cfo@client.test']} busy={false} onConfirm={vi.fn()} onCancel={cancel}/>);
 const scrim=document.querySelector<HTMLElement>('[data-overlay-scrim]')!;
 fireEvent.mouseDown(scrim);fireEvent.click(scrim);
 expect(cancel).not.toHaveBeenCalled();
 fireEvent.keyDown(screen.getByRole('dialog'),{key:'Escape'});
 expect(cancel).toHaveBeenCalledOnce();
});
it('closes once it is no longer open, after its exit',async()=>{
 const view=render(<RecipientReviewDialog open recipients={recipients} busy={false} onRemove={vi.fn()} onApprove={vi.fn()} onCancel={vi.fn()}/>);
 view.rerender(<RecipientReviewDialog open={false} recipients={recipients} busy={false} onRemove={vi.fn()} onApprove={vi.fn()} onCancel={vi.fn()}/>);
 await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());
});
