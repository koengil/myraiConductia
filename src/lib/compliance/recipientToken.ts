import { createHmac, timingSafeEqual } from 'node:crypto';
export type RecipientApprovalSubject = {
  actorId:string;tenantId:string;dealId:string;messageDigest:string;policyFingerprint:string;
};
const PURPOSE='conductia:recipient-approval:v1';
const MAX_AGE=10*60*1000;
function key(){
  const secret=process.env.OUTBOX_SCREEN_SECRET||process.env.INVITE_VERIFICATION_PEPPER;
  if(!secret)throw new Error('Recipient approval signing is not configured');
  return createHmac('sha256',secret).update(PURPOSE).digest();
}
export function mintRecipientToken(subject:RecipientApprovalSubject,now=Date.now()):string {
  const payload=Buffer.from(JSON.stringify({...subject,version:1,iat:now})).toString('base64url');
  return `${payload}.${createHmac('sha256',key()).update(payload).digest('base64url')}`;
}
export function verifyRecipientToken(token:unknown,subject:RecipientApprovalSubject,now=Date.now()):boolean {
  if(typeof token!=='string'||token.length>4096)return false;
  try{
    const parts=token.split('.');if(parts.length!==2)return false;
    const [payload,signature]=parts;
    const expected=createHmac('sha256',key()).update(payload).digest();
    const given=Buffer.from(signature,'base64url');
    if(given.toString('base64url')!==signature||given.length!==expected.length||!timingSafeEqual(given,expected))return false;
    const data:unknown=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));
    if(!data||typeof data!=='object')return false;
    const record=data as Record<string,unknown>;
    return record.version===1 && typeof record.iat==='number' && Number.isFinite(record.iat) && record.iat<=now && now-record.iat<=MAX_AGE &&
      (Object.keys(subject) as (keyof RecipientApprovalSubject)[]).every(k=>record[k]===subject[k]);
  }catch{return false;}
}
