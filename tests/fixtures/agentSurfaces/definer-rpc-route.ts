// A Gate 0 style route (admin client, verified session user) that reaches mailbox
// data only by calling one service-role definer RPC, which checks the actor itself.
import { createSupabaseAdminClient } from '@/lib/supabase/server';

export async function POST(request: Request) {
  const { candidateId, actorId } = (await request.json()) as { candidateId: string; actorId: string };
  return Response.json(
    await createSupabaseAdminClient().rpc('discovery_record_assessment', {
      p_tenant_id: actorId,
      p_candidate_id: candidateId,
      p_assessment: {},
      p_trigger: 'extraction',
    }),
  );
}
