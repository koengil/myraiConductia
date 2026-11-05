import { expect, it } from 'vitest';
import { becomesKnownRecipient, recipientMarking, reviewRecipients } from '@/lib/mail/recipientReview';
it.each(['to','cc','bcc'] as const)('classifies every relationship in %s',field=>{
 // D81 (Storm, Oct 5 demo): an outsider not on the deal is confirmed in every field, To included.
 for(const [relationship,required] of [['bank_team',false],['client',false],['client_advisor',false],['counterparty',true],['counterparty_advisor',true],['unassociated',true],['unverified',true]] as const){
  expect(reviewRecipients([{field,email:'zz-test@example.test',boundary:'external',relationship}])[0].requiresConfirmation).toBe(required);
 }
});
it('asks to confirm an outsider addressed in To who is not on the deal (D81)',()=>{
 const [bob]=reviewRecipients([{field:'to',email:'bob@bob.test',boundary:'external',relationship:'unassociated'}]);
 expect(bob).toMatchObject({requiresConfirmation:true,reason:'not_on_deal'});
});
it('keeps the confirmation in To when the firm has no verified domain to tell outsiders apart',()=>{
 const [someone]=reviewRecipients([{field:'to',email:'someone@elsewhere.test',boundary:'unverified',relationship:'unassociated'}]);
 expect(someone).toMatchObject({requiresConfirmation:true,reason:'not_on_deal'});
});
it('keeps the confirmation for a colleague inside the firm who is not on the deal, even in To',()=>{
 const [colleague]=reviewRecipients([{field:'to',email:'colleague@bank.test',boundary:'internal',relationship:'unassociated'}]);
 expect(colleague.requiresConfirmation).toBe(true);
});
it('preserves each recipient and field in a mixed message',()=>{
 const result=reviewRecipients([{field:'to',email:'a@bank.test',boundary:'internal',relationship:'bank_team'},{field:'bcc',email:'b@client.test',boundary:'external',relationship:'counterparty'}]);
 expect(result.map(r=>[r.field,r.requiresConfirmation,r.reason])).toEqual([['to',false,null],['bcc',true,'counterparty']]);
});
it.each(['to','cc','bcc'] as const)('lets an outsider already on this deal\'s sent mail through in %s without a second approval (Issue #378)',field=>{
 const [known]=reviewRecipients([{field,email:'bob@bob.test',boundary:'external',relationship:'unassociated',knownToDeal:true}]);
 expect(known).toMatchObject({requiresConfirmation:false,reason:null});
 expect(recipientMarking(known)).toBe('external');
});
it('keeps asking for a known address the firm cannot place, or a colleague off the deal (Issue #378)',()=>{
 for(const boundary of ['internal','unverified'] as const){
  const [r]=reviewRecipients([{field:'cc',email:'x@elsewhere.test',boundary,relationship:'unassociated',knownToDeal:true}]);
  expect(r).toMatchObject({requiresConfirmation:true,reason:'not_on_deal'});
 }
});
it('never lets recipient history clear a counterparty or an unverified relationship',()=>{
 for(const relationship of ['counterparty','counterparty_advisor','unverified'] as const){
  expect(reviewRecipients([{field:'to',email:'x@buyer.test',boundary:'external',relationship,knownToDeal:true}])[0].requiresConfirmation).toBe(true);
 }
});
it('marks internal, external and second-approval recipients (Issues #378, #429)',()=>{
 const [banker,client,newcomer,colleague,unplaced]=reviewRecipients([
  {field:'to',email:'a@bank.test',boundary:'internal',relationship:'bank_team'},
  {field:'to',email:'cfo@client.test',boundary:'external',relationship:'client'},
  {field:'cc',email:'new@outside.test',boundary:'external',relationship:'unassociated'},
  {field:'cc',email:'colleague@bank.test',boundary:'internal',relationship:'unassociated'},
  {field:'to',email:'cfo@client.test',boundary:'unverified',relationship:'client'},
 ]);
 expect([banker,client,newcomer,colleague,unplaced].map(recipientMarking)).toEqual(['internal','external','second_approval','second_approval','external']);
 expect([banker,client,newcomer,colleague,unplaced].map(becomesKnownRecipient)).toEqual([false,false,true,false,false]);
});
