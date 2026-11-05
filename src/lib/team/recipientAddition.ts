// Ephemeral navigation handoff after a successful send. Never localStorage,
// URL parameters, analytics or a second retained email/recipient record.
// `team` opens Team's invite with the address; `data-room` opens the Data Room's
// "Give data room access" with it. Each page reads only its own kind, so an
// outside address never lands in Team's every-firm form. Every call names its
// kind, queueing and peeking alike.
export type RecipientAdditionKind = 'team' | 'data-room';
let pending:{project:string;email:string;kind:RecipientAdditionKind;expires:number}|null=null;
export function queueRecipientAddition(project:string,email:string,kind:RecipientAdditionKind){pending={project,email,kind,expires:Date.now()+10*60*1000};}
export function peekRecipientAddition(project:string,kind:RecipientAdditionKind):string|null{return pending?.project===project&&pending.kind===kind&&pending.expires>Date.now()?pending.email:null;}
export function clearRecipientAddition(){pending=null;}
