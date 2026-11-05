import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { userCanAccessDeal } from './access';
import { normalizeInviteEmail } from './inviteDomain';
import { loadMailDomainPolicy } from './mailDomainPolicy';
import { recipientBoundary } from '@/lib/mail/recipientBoundary';
import { reviewRecipients, type RecipientEntry, type RecipientLists, type RecipientRelationship } from '@/lib/mail/recipientReview';
import type { RecipientAffiliation } from '@/lib/constants/recipientAffiliations';
import { OUTBOX_STATUS } from '@/lib/constants/outbox';

type MemberUser={id:string;email:string;company_id:string|null;tenant_id:string;status:string;is_external:boolean};
type Affiliation={normalized_email:string;company_id:string;affiliation:RecipientAffiliation;represented_company_id:string|null;user_id:string|null;invite_id:string|null;revision:number};
type Invite={id:string;email:string;company_id:string;status:string;delivery_status:string;expires_at:string;accepted_user_id:string|null};
export type RecipientSnapshot={tenantId:string;bankId:string;domains:string[];companies:{id:string;tenant_id:string}[];parties:string[];members:{user_id:string;user:MemberUser|null}[];invites:Invite[];affiliations:Affiliation[];
  /** Issue #378: addresses on mail already sent on this deal, the project's recipient history. */
  knownRecipients?:string[]};
export class RecipientPolicyError extends Error {
  constructor(public status:number){super(status===403?'Forbidden':'Recipient relationships unavailable');}
}
export function parseRecipientLists(value:unknown):RecipientLists|null {
  if(!value||typeof value!=='object')return null;
  const v=value as Record<string,unknown>;const result:RecipientLists={to:[],cc:[],bcc:[]};
  for(const field of ['to','cc','bcc'] as const){
    const list=v[field]??[];
    if(!Array.isArray(list)||list.length>20)return null;
    for(const raw of list){const email=typeof raw==='string'?normalizeInviteEmail(raw):null;if(!email)return null;result[field].push(email);}
  }
  return result;
}
export function classifyRecipientSnapshot(s:RecipientSnapshot,lists:RecipientLists,now=Date.now()) {
  const entries:RecipientEntry[]=[];const versions:unknown[]=[];
  const companies=new Set(s.companies.filter(c=>c.tenant_id===s.tenantId).map(c=>c.id));
  const parties=new Set(s.parties.filter(id=>companies.has(id)));
  const known=new Set((s.knownRecipients??[]).flatMap(raw=>{const email=normalizeInviteEmail(raw);return email?[email]:[];}));
  for(const field of ['to','cc','bcc'] as const)for(const raw of lists[field]){
    const email=normalizeInviteEmail(raw);
    if(!email)throw new RecipientPolicyError(400);
    const hasCurrentIdentity=s.members.some(m=>m.user&&normalizeInviteEmail(m.user.email)===email);
    const members=s.members.flatMap(m=>m.user && m.user.id===m.user_id && m.user.status==='active' && m.user.tenant_id===s.tenantId && normalizeInviteEmail(m.user.email)===email && m.user.company_id && companies.has(m.user.company_id) ? [m.user]:[]);
    const member=members.length===1?members[0]:null;
    const matches=s.affiliations.filter(a=>a.normalized_email===email);
    const a=matches.length===1?matches[0]:null;
    let relationship:RecipientRelationship=member?'unverified':'unassociated';
    if(member && !member.is_external && member.company_id===s.bankId)relationship='bank_team';
    else if(a && parties.has(a.company_id)){
      const i=s.invites.find(i=>i.id===a.invite_id&&normalizeInviteEmail(i.email)===email&&i.company_id===a.company_id);
      const memberMatches=member?.company_id===a.company_id &&
        ((a.user_id!==null&&a.user_id===member.id)||(i?.status==='accepted'&&i.accepted_user_id===member.id));
      const pending=!hasCurrentIdentity&&i?.status==='pending'&&i.delivery_status==='sent'&&Date.parse(i.expires_at)>now;
      const advisor=a.affiliation.endsWith('_advisor');
      const represented=advisor ? Boolean(a.represented_company_id&&a.represented_company_id!==a.company_id&&parties.has(a.represented_company_id)) : a.represented_company_id===null;
      if((memberMatches||pending)&&represented)relationship=a.affiliation;
      else if(member||pending)relationship='unverified';
    }
    const boundary=recipientBoundary([email],s.domains);
    // History clears only an address the deal has no affiliation for at all: a lapsed one
    // (expired or revoked invite, a party removed from the deal) stays not_on_deal.
    const knownToDeal=known.has(email)&&matches.length===0;
    entries.push({field,email,relationship,boundary,knownToDeal});
    versions.push([field,email,relationship,boundary,a?.revision??null,a?.represented_company_id??null,knownToDeal]);
  }
  return {recipients:reviewRecipients(entries),policyFingerprint:createHash('sha256').update(JSON.stringify(versions)).digest('hex'),reviewed:true as const};
}

/** No fixture data, no directory exposure, no preflight writes. */
export async function loadRecipientReview(admin:SupabaseClient,actorId:string,dealId:string,lists:RecipientLists) {
  const [{data:actor,error:ae},{data:deal,error:de}]=await Promise.all([
    admin.from('users').select('tenant_id,company_id,is_external,status,department').eq('id',actorId).maybeSingle(),
    admin.from('deals').select('id,tenant_id,bank_id').eq('id',dealId).maybeSingle(),
  ]);
  if(ae||de)throw new RecipientPolicyError(503);
  if(!actor||!deal||actor.tenant_id!==deal.tenant_id||actor.status!=='active')throw new RecipientPolicyError(403);
  if(!await userCanAccessDeal(admin,actorId,dealId))throw new RecipientPolicyError(403);
  // The review judges a bank banker's recipients against the deal's parties. An
  // external member (a client-side director writing to a colleague) or a walled
  // department has no such review: the send goes on with #171's boundary
  // warning only. Not a refusal, or externals could never send deal mail.
  if(actor.is_external||['research','trading'].includes(actor.department))return {recipients:[],policyFingerprint:'',reviewed:false as const};
  const results=await Promise.all([
    admin.from('deal_memberships').select('user_id,user:users!deal_memberships_user_id_fkey(id,email,company_id,tenant_id,status,is_external)').eq('deal_id',dealId),
    admin.from('invites').select('id,email,company_id,status,delivery_status,expires_at,accepted_user_id').eq('deal_id',dealId).eq('tenant_id',deal.tenant_id),
    admin.from('deal_recipient_affiliations').select('normalized_email,company_id,affiliation,represented_company_id,user_id,invite_id,revision').eq('deal_id',dealId).eq('tenant_id',deal.tenant_id),
    admin.from('deal_parties').select('company_id').eq('deal_id',dealId),
    // Issue #378: the project's recipient history is its SENT mail only (D80:
    // nothing records an email that was not sent). Newest first; past the cap
    // an older recipient is asked again, never trusted unseen.
    admin.from('outbound_messages').select('to_emails,cc_emails,bcc_emails').eq('deal_id',dealId).eq('tenant_id',deal.tenant_id)
      .eq('status',OUTBOX_STATUS.SENT).order('created_at',{ascending:false}).limit(1000),
  ]);
  if(results.some(r=>r.error))throw new RecipientPolicyError(503);
  const partyIds=(results[3].data??[]).map(p=>p.company_id as string);
  const {data:companies,error:ce}=await admin.from('companies').select('id,tenant_id').in('id',[deal.bank_id,...partyIds]).eq('tenant_id',deal.tenant_id);
  if(ce)throw new RecipientPolicyError(503);
  const policy=await loadMailDomainPolicy(admin,actor);
  return classifyRecipientSnapshot({tenantId:deal.tenant_id,bankId:deal.bank_id,domains:policy.verifiedDomains,
    companies:companies??[],parties:partyIds,members:results[0].data as unknown as RecipientSnapshot['members']??[],
    invites:results[1].data as unknown as Invite[]??[],affiliations:results[2].data as unknown as Affiliation[]??[],
    knownRecipients:((results[4].data??[]) as {to_emails:string[]|null;cc_emails:string[]|null;bcc_emails:string[]|null}[])
      .flatMap(m=>[...(m.to_emails??[]),...(m.cc_emails??[]),...(m.bcc_emails??[])])},lists);
}
