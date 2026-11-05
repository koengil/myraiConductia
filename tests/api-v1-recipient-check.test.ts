import { expect, it } from 'vitest';
import { classifyRecipientSnapshot, type RecipientSnapshot } from '@/lib/api/v1/recipientReview';
const snapshot: RecipientSnapshot = {
 tenantId:'t',bankId:'bank',domains:['bank.test'],companies:[{id:'bank',tenant_id:'t'},{id:'client',tenant_id:'t'}],
 parties:['client'],members:[{user_id:'u',user:{id:'u',email:'a@client.test',company_id:'client',tenant_id:'t',status:'active',is_external:true}}],
 invites:[],affiliations:[{normalized_email:'a@client.test',company_id:'client',affiliation:'client',represented_company_id:null,user_id:'u',invite_id:null,revision:1}],
};
const lists={to:[],cc:['a@client.test'],bcc:[]};
it('uses explicit affiliation, not the company domain',()=>{
 expect(classifyRecipientSnapshot(snapshot,lists).recipients[0].relationship).toBe('client');
 expect(classifyRecipientSnapshot(snapshot,{...lists,cc:['colleague@client.test']}).recipients[0].requiresConfirmation).toBe(true);
});
it('an outsider on the deal\'s sent mail is known: no second approval, and the policy fingerprint moves (Issue #378)',()=>{
 const newcomer={...lists,cc:['new@outside.test']};
 const before=classifyRecipientSnapshot(snapshot,newcomer);
 expect(before.recipients[0]).toMatchObject({reason:'not_on_deal',requiresConfirmation:true,knownToDeal:false});
 const after=classifyRecipientSnapshot({...snapshot,knownRecipients:['New@Outside.test']},newcomer);
 expect(after.recipients[0]).toMatchObject({relationship:'unassociated',requiresConfirmation:false,reason:null,knownToDeal:true});
 expect(after.policyFingerprint).not.toBe(before.policyFingerprint);
});
it('recipient history never clears a colleague off the deal (Issue #378)',()=>{
 const r=classifyRecipientSnapshot({...snapshot,knownRecipients:['colleague@bank.test']},{...lists,cc:['colleague@bank.test']}).recipients[0];
 expect(r).toMatchObject({boundary:'internal',relationship:'unassociated',requiresConfirmation:true});
});
it('revoked membership removes the client exemption',()=>{
 const before=classifyRecipientSnapshot(snapshot,lists);
 const after=classifyRecipientSnapshot({...snapshot,members:[]},lists);
 expect(after.recipients[0].requiresConfirmation).toBe(true);expect(after.policyFingerprint).not.toBe(before.policyFingerprint);
});
it('access roles cannot stand in for affiliation',()=>{expect(classifyRecipientSnapshot({...snapshot,affiliations:[]},lists).recipients[0].relationship).toBe('unverified');});
it('cross-tenant or moved-company members cannot inherit the exemption',()=>{
 for(const user of [{...snapshot.members[0].user!,tenant_id:'other'},{...snapshot.members[0].user!,company_id:'bank'}])expect(classifyRecipientSnapshot({...snapshot,members:[{user_id:'u',user}]},lists).recipients[0].requiresConfirmation).toBe(true);
});
it.each(['pending','revoked','expired','accepted'])('checks invitation state %s',status=>{
 const s:RecipientSnapshot={...snapshot,members:[],affiliations:[{...snapshot.affiliations[0],user_id:null,invite_id:'i'}],invites:[{id:'i',email:'a@client.test',company_id:'client',status,delivery_status:'sent',expires_at:'2099-01-01',accepted_user_id:null}]};
 expect(classifyRecipientSnapshot(s,lists).recipients[0].requiresConfirmation).toBe(status!=='pending');
 expect(classifyRecipientSnapshot({...s,invites:[{...s.invites[0],expires_at:'2000-01-01'}]},lists).recipients[0].requiresConfirmation).toBe(true);
 expect(classifyRecipientSnapshot({...s,invites:[{...s.invites[0],delivery_status:'unsent'}]},lists).recipients[0].requiresConfirmation).toBe(true);
});
it('counterparty membership always requires approval',()=>{const s:RecipientSnapshot={...snapshot,affiliations:[{...snapshot.affiliations[0],affiliation:'counterparty'}]};expect(classifyRecipientSnapshot(s,lists).recipients[0].reason).toBe('counterparty');});
it('advisor representation must still name a current party',()=>{const s:RecipientSnapshot={...snapshot,affiliations:[{...snapshot.affiliations[0],affiliation:'client_advisor',represented_company_id:'removed'}]};expect(classifyRecipientSnapshot(s,lists).recipients[0].relationship).toBe('unverified');});
it('only current bank deal members get the bank-team classification',()=>{
 const s:RecipientSnapshot={...snapshot,members:[{user_id:'b',user:{id:'b',email:'b@bank.test',company_id:'bank',tenant_id:'t',status:'active',is_external:false}}]};
 expect(classifyRecipientSnapshot(s,{...lists,to:['b@bank.test']}).recipients[0].relationship).toBe('bank_team');
 expect(classifyRecipientSnapshot(s,{...lists,to:['stranger@bank.test']}).recipients[0].relationship).toBe('unassociated');
});
it.each(['bank','unlisted-company'])('does not let a pending invitation override a current member moved to %s',companyId=>{
 const s:RecipientSnapshot={...snapshot,members:[{user_id:'u',user:{...snapshot.members[0].user!,company_id:companyId}}],affiliations:[{...snapshot.affiliations[0],user_id:null,invite_id:'i'}],invites:[{id:'i',email:'a@client.test',company_id:'client',status:'pending',delivery_status:'sent',expires_at:'2099-01-01',accepted_user_id:null}]};
 expect(classifyRecipientSnapshot(s,lists).recipients[0].requiresConfirmation).toBe(true);
});
it.each(['revoked','expired'])('recipient history never clears an address with a lapsed affiliation (%s invite) (Issue #378 review)',state=>{
 const s:RecipientSnapshot={...snapshot,members:[],knownRecipients:['x@buyer.test'],
  affiliations:[{normalized_email:'x@buyer.test',company_id:'client',affiliation:'counterparty',represented_company_id:null,user_id:null,invite_id:'i',revision:1}],
  invites:[{id:'i',email:'x@buyer.test',company_id:'client',status:state==='revoked'?'revoked':'pending',delivery_status:'sent',expires_at:state==='expired'?'2000-01-01':'2099-01-01',accepted_user_id:null}]};
 const r=classifyRecipientSnapshot(s,{...lists,cc:['x@buyer.test']}).recipients[0];
 expect(r).toMatchObject({boundary:'external',relationship:'unassociated',knownToDeal:false,requiresConfirmation:true,reason:'not_on_deal'});
});
it('recipient history never clears the address of a party removed from the deal (Issue #378 review)',()=>{
 const s:RecipientSnapshot={...snapshot,parties:[],members:[],knownRecipients:['a@client.test']};
 const r=classifyRecipientSnapshot(s,lists).recipients[0];
 expect(r).toMatchObject({knownToDeal:false,requiresConfirmation:true});
});
