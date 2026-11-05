'use client';
import * as React from 'react';
import { RELATIONSHIP_LABELS,type RecipientDecision,type RecipientLists } from '@/lib/mail/recipientReview';
export function useRecipientReview(dealRef:string|undefined,lists:RecipientLists,delay=250) {
 const key=JSON.stringify([dealRef,lists]);
 const [context,setContext]=React.useState(key);
 const [result,setResult]=React.useState<{key:string;status:'ready'|'error';recipients:RecipientDecision[]}|null>(null);
 const [attempt,setAttempt]=React.useState(0);
 if(context!==key){setContext(key);setResult(null);}
 const active=Boolean(dealRef && lists.to.length+lists.cc.length+lists.bcc.length);
 React.useEffect(()=>{
  if(!active)return;
  let current=true;const controller=new AbortController();
  const timer=setTimeout(async()=>{
   try{
    const [ref,recipients]=JSON.parse(key) as [string,RecipientLists];
    const res=await fetch(`/api/v1/deals/${encodeURIComponent(ref)}/recipient-check`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(recipients),signal:controller.signal,cache:'no-store'});
    if(!res.ok)throw Error('Unavailable');
    const body=await res.json();
    if(!Array.isArray(body.recipients)||!body.recipients.every((r:RecipientDecision)=>r&&typeof r.email==='string'&&['to','cc','bcc'].includes(r.field)&&Object.hasOwn(RELATIONSHIP_LABELS,r.relationship)&&typeof r.requiresConfirmation==='boolean'))throw Error('Invalid response');
    if(current)setResult({key,status:'ready',recipients:body.recipients});
   }catch{if(current)setResult({key,status:'error',recipients:[]});}
  },delay);
  return()=>{current=false;clearTimeout(timer);controller.abort();};
 },[active,key,attempt,delay]);
 return {status:!active?'idle' as const:result?.key===key?result.status:'loading' as const,
  recipients:result?.key===key?result.recipients:[],retry:()=>{setResult(null);setAttempt(v=>v+1);}};
}
