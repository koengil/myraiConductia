'use client';
import { Button } from '@/components/atoms';
import { RELATIONSHIP_LABELS,recipientMarking,type RecipientDecision,type RecipientField,type RecipientMarking } from '@/lib/mail/recipientReview';
// Storm's colours (Issue #378): orange for anyone outside the firm, bright red
// for a recipient who needs a second approval. Inside the firm the chip stays
// unmarked, with a text 'Internal' marker (Issue #429). Colour is never the
// only signal: every chip names its marking.
const MARKING_CLASS:Record<RecipientMarking,string>={
 internal:'bg-[var(--surface-subtle)] text-[var(--ink-secondary)]',
 external:'bg-[var(--hold-fill)] text-[var(--hold-deep)]',
 second_approval:'bg-[var(--negative-fill)] text-[var(--negative-deep)] ring-1 ring-[var(--negative)]',
};
const MARKING_LABEL:Record<RecipientMarking,string>={internal:'Internal',external:'External',second_approval:'Needs approval'};
export function RecipientRelationshipList({recipients,onRemove}:{recipients:readonly RecipientDecision[];onRemove:(field:RecipientField,email:string)=>void}) {
 return <ul aria-label="Recipient relationships" className="flex flex-wrap gap-2">
  {recipients.map((r,index)=>{const marking=recipientMarking(r);return <li key={`${r.field}:${r.email}:${index}`} data-marking={marking} className={`flex items-center gap-2 rounded-[var(--radius-control)] px-2 py-1 font-sans text-[length:var(--text-sm)] ${MARKING_CLASS[marking]}`}>
   <span>{r.field==='bcc'?'Bcc':r.field==='cc'?'Cc':'To'}: {r.email} · {MARKING_LABEL[marking]} · {RELATIONSHIP_LABELS[r.relationship]}{r.relationship==='unassociated'&&r.knownToDeal&&!r.requiresConfirmation?' · Emailed on this deal before':''}{r.boundary==='unverified'?' · Organization unverified':''}</span>
   {/* Only a flagged recipient can be removed here (Jess, Oct 5 demo): the deal team and confirmed relationships carry no Remove. */}
   {r.requiresConfirmation?<Button size="sm" variant="ghost" aria-label={`Remove ${r.email} from ${r.field}`} onClick={()=>onRemove(r.field,r.email)}>Remove</Button>:null}
  </li>;})}
 </ul>;
}
