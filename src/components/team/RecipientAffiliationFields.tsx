'use client';
import { RECIPIENT_AFFILIATIONS,type RecipientAffiliation } from '@/lib/constants/recipientAffiliations';
import { RELATIONSHIP_LABELS } from '@/lib/mail/recipientReview';
import type { LiveParty } from '@/lib/team/roster';
const selectClass='rounded-[var(--radius-control)] border border-[var(--stroke)] bg-[var(--surface)] p-2 text-[length:var(--text-sm)] text-[var(--ink)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]';
export function RecipientAffiliationFields({value,representedCompanyId,companyId,parties,onChange}:{value:RecipientAffiliation|'';representedCompanyId:string;companyId:string;parties:LiveParty[];onChange:(affiliation:RecipientAffiliation|'',represented:string)=>void}){
 return <div className="flex flex-col gap-2 font-sans text-[length:var(--text-sm)] text-[var(--ink)]">
  <label className="flex flex-col gap-1">Deal relationship<select className={selectClass} value={value} onChange={e=>onChange(e.target.value as RecipientAffiliation|'','')}><option value="">Choose relationship</option>{RECIPIENT_AFFILIATIONS.map(v=><option key={v} value={v}>{RELATIONSHIP_LABELS[v]}</option>)}</select></label>
  {value.endsWith('_advisor')?<label className="flex flex-col gap-1">Represented deal party<select className={selectClass} value={representedCompanyId} onChange={e=>onChange(value,e.target.value)}><option value="">Choose represented party</option>{parties.filter(p=>p.companyId!==companyId).map(p=><option key={p.companyId} value={p.companyId}>{p.companyName??p.companyId}</option>)}</select></label>:null}
 </div>;
}
