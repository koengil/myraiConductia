'use client';
import * as React from 'react';
import { Button } from '@/components/atoms';
import type { LiveRoster } from '@/lib/team/roster';
import type { RecipientAffiliation } from '@/lib/constants/recipientAffiliations';
import type { PendingInvite } from './LiveTeamRoster';
import { RecipientAffiliationFields } from './RecipientAffiliationFields';
type Row={normalized_email:string;affiliation:RecipientAffiliation;represented_company_id:string|null;revision:number};
type Person={key:string;email:string;companyId:string;userId:string|null;inviteId:string|null};
function RelationshipForm({person,row,roster,dealId,onSaved}:{person:Person;row?:Row;roster:LiveRoster;dealId:string;onSaved:(row:Row)=>void}){
 const [value,setValue]=React.useState<RecipientAffiliation|''>(row?.affiliation??'');
 const [represented,setRepresented]=React.useState(row?.represented_company_id??'');
 const [busy,setBusy]=React.useState(false);const [error,setError]=React.useState('');
 async function save(){
  if(busy||!value||(value.endsWith('_advisor')&&!represented))return;
  setBusy(true);setError('');
  try{
   const res=await fetch(`/api/v1/deals/${encodeURIComponent(dealId)}/recipient-affiliations`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:person.email,companyId:person.companyId,affiliation:value,representedCompanyId:represented||null,userId:person.userId,inviteId:person.inviteId,expectedRevision:row?.revision??null})});
   if(!res.ok)throw Error(res.status===409?'This relationship changed. Reload Team before saving.':'The relationship could not be saved.');
   const body=await res.json();onSaved(body.affiliation);
  }catch(e){setError(e instanceof Error?e.message:'The relationship could not be saved.');}finally{setBusy(false);}
 }
 return <div className="flex flex-col gap-2">
  <RecipientAffiliationFields value={value} representedCompanyId={represented} companyId={person.companyId} parties={roster.parties} onChange={(v,r)=>{setValue(v);setRepresented(r);}}/>
  {error?<p role="alert">{error}</p>:null}
  <Button size="sm" disabled={busy||!value||(value.endsWith('_advisor')&&!represented)} onClick={()=>void save()}>Save relationship</Button>
 </div>;
}
export function RecipientAffiliationEditor({dealId,roster,invites}:{dealId:string;roster:LiveRoster;invites:PendingInvite[]}){
 const [state,setState]=React.useState<{deal:string;status:'ready'|'denied'|'error';rows:Row[]}|null>(null);
 const [selected,setSelected]=React.useState('');const [attempt,setAttempt]=React.useState(0);
 React.useEffect(()=>{
  let active=true;const controller=new AbortController();
  void (async()=>{try{
   const res=await fetch(`/api/v1/deals/${encodeURIComponent(dealId)}/recipient-affiliations`,{signal:controller.signal,cache:'no-store'});
   if(!res.ok){if(active)setState({deal:dealId,status:res.status===403||res.status===404?'denied':'error',rows:[]});return;}
   const body=await res.json();if(!Array.isArray(body.affiliations))throw Error('Invalid response');
   if(active)setState({deal:dealId,status:'ready',rows:body.affiliations});
  }catch{if(active)setState({deal:dealId,status:'error',rows:[]});}})();
  return()=>{active=false;controller.abort();};
 },[dealId,attempt]);
 if(state?.deal!==dealId)return <p className="px-5 text-[length:var(--text-sm)]">Loading recipient relationships.</p>;
 if(state.status==='denied')return null;
 if(state.status==='error')return <div className="px-5"><span>Recipient relationships unavailable.</span><Button size="sm" variant="secondary" onClick={()=>setAttempt(v=>v+1)}>Retry relationships</Button></div>;
 const people:Person[]=[...roster.members.filter(m=>m.email&&m.companyId&&m.companyId!==roster.bankCompanyId).map(m=>({key:`user:${m.userId}`,email:m.email!,companyId:m.companyId!,userId:m.userId,inviteId:null})),...invites.filter(i=>i.status==='pending'&&i.companyId!==roster.bankCompanyId).map(i=>({key:`invite:${i.id}`,email:i.email,companyId:i.companyId,userId:null,inviteId:i.id}))];
 const person=people.find(p=>p.key===selected);const row=person?state.rows.find(r=>r.normalized_email===person.email.trim().toLowerCase()):undefined;
 return <section aria-label="Recipient relationship management" className="mx-5 my-3 flex flex-col gap-3 rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] p-3 font-sans text-[length:var(--text-sm)] text-[var(--ink)]">
  <h2 className="font-semibold">Recipient relationships</h2><p>Record whom each person represents. Access permissions stay separate. Counterparties always require email confirmation.</p>
  <label className="flex flex-col gap-1">Person<select className="rounded border border-[var(--stroke)] bg-[var(--surface)] p-2 focus-visible:outline-2 focus-visible:outline-[var(--accent)]" value={selected} onChange={e=>setSelected(e.target.value)}><option value="">Choose a member or pending invitation</option>{people.map(p=><option key={p.key} value={p.key}>{p.email}{p.inviteId?' (invitation pending)':''}</option>)}</select></label>
  {person?<RelationshipForm key={`${dealId}:${person.key}:${row?.revision??0}`} person={person} row={row} roster={roster} dealId={dealId} onSaved={saved=>setState({...state,rows:[...state.rows.filter(r=>r.normalized_email!==saved.normalized_email),saved]})}/>:null}
 </section>;
}
