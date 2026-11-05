import { NextResponse } from 'next/server';
import { jsonError, requireApiUser, resolveDealRef } from '@/lib/api/v1/http';
import { forbiddenOrNotVisible } from '@/lib/api/v1/dealNotVisible';
import { requireFlag } from '@/lib/flags/requireFlag';
import { affiliationManagerStatus, affiliationRpcStatus, parseAffiliationInput } from '@/lib/api/v1/recipientAffiliations';
type Context = {params:Promise<{dealId:string}>};
async function authorize(context:Context) {
  const gate=await requireFlag('platform_onboarding'); if(gate) return {response:gate} as const;
  const auth=await requireApiUser(); if(!auth.ok) return {response:auth.response} as const;
  const deal=await resolveDealRef(auth.admin,(await context.params).dealId);
  if(!deal) return {response:jsonError('Deal not found',404)} as const;
  const status=await affiliationManagerStatus(auth.admin,auth.user.id,deal.id);
  if(status===403) return {response:await forbiddenOrNotVisible(auth.admin,auth.user.id,deal.id,'Forbidden')} as const;
  if(status!==200) return {response:jsonError('Relationship authority unavailable',status)} as const;
  return {auth,deal} as const;
}
export async function GET(_request:Request,context:Context) {
  try {
    const access=await authorize(context); if(access.response) return access.response;
    const {data,error}=await access.auth.admin.from('deal_recipient_affiliations').select('*').eq('deal_id',access.deal.id);
    if(error) return jsonError('Relationships unavailable',503);
    return NextResponse.json({affiliations:data??[]},{headers:{'Cache-Control':'private, no-store'}});
  } catch {return jsonError('Relationships unavailable',503);}
}
export async function PUT(request:Request,context:Context) {
  try {
    const access=await authorize(context); if(access.response) return access.response;
    let input; try {input=parseAffiliationInput(await request.json());} catch {return jsonError('Invalid relationship',400);}
    if(!input) return jsonError('Invalid relationship',400);
    const {data,error}=await access.auth.admin.rpc('set_recipient_affiliation',{
      p_actor:access.auth.user.id,p_deal_id:access.deal.id,p_email:input.email,
      p_company_id:input.companyId,p_affiliation:input.affiliation,
      p_represented_company_id:input.representedCompanyId,p_user_id:input.userId,
      p_invite_id:input.inviteId,p_expected_revision:input.expectedRevision,
    });
    if(error) return jsonError('Relationship could not be saved',affiliationRpcStatus(error.message));
    return NextResponse.json({affiliation:data});
  } catch {return jsonError('Relationships unavailable',503);}
}
