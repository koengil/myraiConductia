import { NextResponse } from 'next/server';
import { requireFlag } from '@/lib/flags/requireFlag';
import { requireApiUser,resolveDealRef,jsonError } from '@/lib/api/v1/http';
import { userCanAccessDeal } from '@/lib/api/v1/access';
import { dealNotVisible } from '@/lib/api/v1/dealNotVisible';
import { loadRecipientReview,parseRecipientLists,RecipientPolicyError } from '@/lib/api/v1/recipientReview';
export async function POST(request:Request,context:{params:Promise<{dealId:string}>}) {
  const gate=await requireFlag('mail_channel');if(gate)return gate;
  const auth=await requireApiUser();if(!auth.ok)return auth.response;
  let lists;try{lists=parseRecipientLists(await request.json());}catch{return jsonError('Invalid recipients',400);}
  if(!lists)return jsonError('Invalid recipients',400);
  try{
    const deal=await resolveDealRef(auth.admin,(await context.params).dealId);
    if(!deal)return jsonError('Deal not found',404);
    if(!await userCanAccessDeal(auth.admin,auth.user.id,deal.id))return dealNotVisible();
    return NextResponse.json(await loadRecipientReview(auth.admin,auth.user.id,deal.id,lists),{headers:{'Cache-Control':'private, no-store'}});
  }catch(error){return jsonError('Recipient relationships unavailable',error instanceof RecipientPolicyError?error.status:503);}
}
